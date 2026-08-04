import numpy as np
import rasterio
import os
import warnings
import psutil
from pyproj import Geod
from skimage import measure
from rasterio.windows import Window
from shapely.geometry import LineString, box, MultiLineString
from shapely.ops import linemerge

def check_available_ram_mb():
    """
    Queries the operating system layer dynamically to determine 
    exactly how many Megabytes of free RAM are available.
    Works locally and inside CryoCloud containers.
    """
    virtual_memory = psutil.virtual_memory()
    # virtual_memory.available returns bytes -> convert to Megabytes
    return virtual_memory.available / (1024 ** 2)

def raster_io_check(DEM_path, available_ram_mb):
    """
    Pre-flight metadata check. Evaluates files against system constraints
    and determines whether a windowed pipeline or casting is required.
    """
    #Path validation
    if not os.path.exists(DEM_path):
        raise FileNotFoundError(f"The specified DEM file could not be found at: '{DEM_path}'")
        
    #Determine I/O method
    try:
        with rasterio.open(DEM_path) as src:
            # Safely capture structural metadata
            width = src.width or 0
            height = src.height or 0
            band_count = src.count or 0
            
            # Fail-safe guard for zero-band or malformed files
            if band_count == 0 or width == 0 or height == 0:
                raise ValueError(f"The file at '{DEM_path}' is missing essential raster dimensions or bands.")
            
            # Safely grab the data type now that we know at least 1 band exists
            raw_dtype_str = src.dtypes[0]
            
            needs_casting = raw_dtype_str != 'float32'
            bytes_per_pixel = np.dtype(raw_dtype_str).itemsize
            
            # Memory footprints
            raw_size_mb = (width * height * bytes_per_pixel) / (1024 ** 2)
            float32_size_mb = (width * height * 4) / (1024 ** 2)
            
            peak_ram_required_mb = (raw_size_mb + float32_size_mb) if needs_casting else float32_size_mb
            
            # Safe threshold rule
            safe_ram_budget_mb = available_ram_mb * 0.60
            use_windowed_io = peak_ram_required_mb > safe_ram_budget_mb
            
            return {
                "use_windowed_io": use_windowed_io,
                "needs_casting": needs_casting,
                "band_count": band_count,
                "peak_ram_mb": peak_ram_required_mb
            }

    # Catch file corruption, invalid formats, or broken headers
    except rasterio.errors.RasterioIOError as e:
        raise IOError(
            f"Rasterio could not open '{DEM_path}'. The file may be corrupted, "
            f"truncated, or is an unsupported image format. Details: {e}"
        )
def load_DEM(DEM_path, needs_casting, band_count):
    
    try:
        with rasterio.open(DEM_path) as src:
            if band_count > 1:
                warnings.warn(
                    f"Warning: The raster at '{DEM_path}' contains {src.count} bands. "
                    "This tool will proceed using Band 1 for calculations. "
                    "Please ensure your input is a valid DEM with elevation data in Band 1.",
                    UserWarning
                )

            raw_dtype_str = src.dtypes[0]

            if needs_casting:
                if np.dtype(raw_dtype_str).itemsize > np.dtype('float32').itemsize:
                    warnings.warn(
                        f"Warning: The raster at '{DEM_path}' has dtype '{raw_dtype_str}', which has "
                        "greater precision than float32. Casting to float32 may truncate elevation values.",
                        UserWarning
                    )
                DEM_array = src.read(1).astype('float32')
            else:
                DEM_array = src.read(1).astype('float32', copy=False)
                
            nodata = src.nodata
            if nodata is not None:
                DEM_array = np.where(DEM_array == nodata, np.nan, DEM_array)
            else:
                warnings.warn(
                    f"Warning: The raster at '{DEM_path}' does not have a defined 'nodata' value. "
                    "Edges or missing data regions may distort GIA calculations.",
                    UserWarning
                )
    
        return DEM_array, src.transform, src.crs

    except rasterio.errors.RasterioIOError as e:
        raise IOError(f"Failed to read the file. Details: {e}")


def _warn_if_origin_disconnected(transform, shape, origin_coords):
    """
    Checks whether the tilt origin falls within the raster's geographic extent.
    If it doesn't, the resulting strandline will still be computed, but it will
    be geometrically disconnected from the point the user specified as its origin.
    """
    height, width = shape
    left, bottom, right, top = rasterio.transform.array_bounds(height, width, transform)
    lon, lat = origin_coords
    if not (left <= lon <= right and bottom <= lat <= top):
        warnings.warn(
            f"The tilt origin {origin_coords} lies outside the raster's extent "
            f"(lon range [{left:.6f}, {right:.6f}], lat range [{bottom:.6f}, {top:.6f}]). "
            "The resulting strandline contour will be disconnected from the specified origin point.",
            UserWarning
        )


def tilt_DEM_windowed(DEM_path, output_path, origin_coords, tilt_azimuth, tilt_factor, tile_size=512):
    """
    Streams the DEM through uniform tile_size x tile_size windows, applying
    the directional tilt to each tile independently and writing the result
    straight to disk. Used when raster_io_check flags a file as exceeding
    the safe RAM budget.

    tile_size controls peak memory usage directly (one tile_size x tile_size
    float32 block in memory at a time), independent of the source file's own
    internal block/tile layout -- this was previously delegated to the
    source's native blocking via src.block_windows(1), which gave no actual
    control over memory footprint if the source happened to have large or
    unusual internal blocks.

    Returns (output_path, transform, crs) to mirror the (array, transform, crs)
    contract load_DEM/calculate_tilt use for the standard, in-memory pipeline —
    the "data" component is a path on disk here instead of an array, since
    avoiding a full in-memory array is the whole point of windowing.
    """
    with rasterio.open(DEM_path) as src:
        _warn_if_origin_disconnected(src.transform, (src.height, src.width), origin_coords)
        profile = src.profile.copy()
        profile.update(dtype='float32')
        out_transform = src.transform
        out_crs = src.crs
        width, height = src.width, src.height
        with rasterio.open(output_path, 'w', **profile) as dst:
            for row_off in range(0, height, tile_size):
                for col_off in range(0, width, tile_size):
                    win_h = min(tile_size, height - row_off)
                    win_w = min(tile_size, width - col_off)
                    window = Window(col_off, row_off, win_w, win_h)
                    block = src.read(1, window=window).astype('float32')
                    nodata = src.nodata
                    if nodata is not None:
                        block = np.where(block == nodata, np.nan, block)
                    window_transform = src.window_transform(window)
                    tilted_block = calculate_tilt(
                        block, window_transform, origin_coords, tilt_azimuth, tilt_factor,
                        warn_if_disconnected=False,
                    )
                    dst.write(tilted_block, 1, window=window)
    return output_path, out_transform, out_crs


def extract_strandline_contours_windowed(tilted_DEM_path, target_elevation, tile_size=1024, halo=32):
    """
    Extracts strandline contours tile-by-tile from a large tilted DEM, using a
    padded "halo" read around each tile so contours crossing tile boundaries
    still trace correctly, then clips and merges fragments back together.
    """
    fragments = []
    with rasterio.open(tilted_DEM_path) as src:
        width, height = src.width, src.height
        for row_off in range(0, height, tile_size):
            for col_off in range(0, width, tile_size):
                core_h = min(tile_size, height - row_off)
                core_w = min(tile_size, width - col_off)
                # Padded read window, clipped to raster bounds
                pad_row_off = max(row_off - halo, 0)
                pad_col_off = max(col_off - halo, 0)
                pad_row_end = min(row_off + core_h + halo, height)
                pad_col_end = min(col_off + core_w + halo, width)
                padded_window = Window(pad_col_off, pad_row_off,
                                        pad_col_end - pad_col_off,
                                        pad_row_end - pad_row_off)
                block = src.read(1, window=padded_window)
                nodata = src.nodata
                if nodata is not None:
                    block = np.where(block == nodata, np.nan, block)
                window_transform = src.window_transform(padded_window)
                # Reuses the existing full-array contour function unchanged.
                # extract_strandline_contours validates target_elevation against
                # the LOCAL min/max of whatever array it's given -- which here is
                # just this one tile, not the whole raster. A target elevation
                # that's perfectly valid for the raster overall will routinely
                # fall outside a given tile's local range (most DEMs vary in
                # elevation across their extent), and an all-NaN tile is equally
                # unremarkable at this per-tile granularity. Both simply mean
                # "no contour in this tile," not an invalid request -- so these
                # specific ValueErrors are swallowed here rather than propagated.
                try:
                    tile_contours = extract_strandline_contours(block, window_transform, target_elevation)
                except ValueError:
                    continue
                # Core tile's real-world bounding box (unpadded)
                core_transform = src.window_transform(Window(col_off, row_off, core_w, core_h))
                minx, maxy = core_transform * (0, 0)
                maxx, miny = core_transform * (core_w, core_h)
                core_bbox = box(minx, miny, maxx, maxy)
                for coords in tile_contours:
                    line = LineString(coords)
                    clipped = line.intersection(core_bbox)
                    if clipped.is_empty:
                        continue
                    # intersection can return LineString or MultiLineString
                    if clipped.geom_type == "LineString":
                        fragments.append(clipped)
                    else:
                        fragments.extend(clipped.geoms)
    merged = linemerge(MultiLineString(fragments))
    return merged


def _prepare_gpkg_output(gpkg_path, overwrite):
    """
    Deletes any pre-existing file at gpkg_path when overwrite is True.

    Deletes the *entire* file, not just a named raster table -- consistent
    with the assumption used throughout this codebase that one .gpkg output
    path belongs to one job/run, not a multi-layer file accreted across
    separate calls. Shared by write_dem_to_gpkg and write_dem_to_gpkg_windowed
    so the two don't drift out of sync.
    """
    if overwrite and os.path.exists(gpkg_path):
        os.remove(gpkg_path)


def write_dem_to_gpkg(dem_array, transform, crs, gpkg_path, table_name="modified_dem", overwrite=True):
    """
    Embeds the (tilted) DEM as a raster layer inside a GeoPackage, so the
    contour vector layer and the modified DEM can ship as a single .gpkg file.

    overwrite=True (default) deletes any pre-existing file at gpkg_path
    first -- the entire file, not just the named raster table, since this
    codebase treats one .gpkg output path as belonging to one job/run.
    Direct callers that instead want to add a raster layer to an existing
    multi-layer .gpkg without touching its other layers can pass
    overwrite=False to restore GDAL's strict raise-if-exists behavior.
    """
    _prepare_gpkg_output(gpkg_path, overwrite)
    profile = {
        "driver": "GPKG",
        "height": dem_array.shape[0],
        "width": dem_array.shape[1],
        "count": 1,
        "dtype": "float32",
        "crs": crs,
        "transform": transform,
        "RASTER_TABLE": table_name,
        "APPEND_SUBDATASET": "YES",   # lets it coexist with the contour vector layer
    }
    with rasterio.open(gpkg_path, "w", **profile) as dst:
        dst.write(dem_array, 1)


def write_dem_to_gpkg_windowed(source_raster_path, gpkg_path, table_name="modified_dem",
                                tile_size=512, overwrite=True):
    """
    Copies an on-disk raster into a GeoPackage raster table tile-by-tile,
    never holding more than one tile_size x tile_size block in memory.
    Used by the windowed pipeline so include_dem=True no longer negates
    the memory savings windowing exists to provide (see app.py).

    overwrite behaves identically to write_dem_to_gpkg's own parameter (see
    _prepare_gpkg_output) -- both delete the whole file, not just the named
    table, when a prior file already exists at gpkg_path.
    """
    _prepare_gpkg_output(gpkg_path, overwrite)
    with rasterio.open(source_raster_path) as src:
        profile = {
            "driver": "GPKG",
            "height": src.height,
            "width": src.width,
            "count": 1,
            "dtype": "float32",
            "crs": src.crs,
            "transform": src.transform,
            "RASTER_TABLE": table_name,
            "APPEND_SUBDATASET": "YES",
        }
        with rasterio.open(gpkg_path, "w", **profile) as dst:
            for row_off in range(0, src.height, tile_size):
                for col_off in range(0, src.width, tile_size):
                    win_h = min(tile_size, src.height - row_off)
                    win_w = min(tile_size, src.width - col_off)
                    window = Window(col_off, row_off, win_w, win_h)
                    block = src.read(1, window=window).astype("float32")
                    dst.write(block, 1, window=window)
    return gpkg_path


def calculate_tilt(DEM_array, transform, origin_coords, tilt_azimuth, tilt_factor, warn_if_disconnected=True):
    """
    Applies a directional planar downward tilt across a DEM starting from an origin point.
    Cells in the direction of the tilt azimuth are adjusted linearly.
    Cells behind the tilt plane baseline experience zero change.

    warn_if_disconnected: set to False when calling this per-block from a windowed
    pipeline, since a block's local extent will rarely contain the origin even when
    the full raster does; the windowed caller performs this check once, upfront,
    against the full raster extent instead.
    """
    if warn_if_disconnected:
        _warn_if_origin_disconnected(transform, DEM_array.shape, origin_coords)

    geod = Geod(ellps='WGS84')
    lon_start, lat_start = origin_coords
    
    #Generate the coordinate grid using the raster's affine transform
    rows, cols = np.indices(DEM_array.shape)
    lons, lats = rasterio.transform.xy(transform, rows, cols)
    # rasterio.transform.xy flattens 2D row/col inputs into 1D output arrays,
    # so reshape back to the DEM's original grid before doing elementwise math.
    lons = np.array(lons).reshape(DEM_array.shape)
    lats = np.array(lats).reshape(DEM_array.shape)
    
    #Calculate curved-earth distance and direction to every single pixel
    forward_azimuth, _, distance_meters = geod.inv(
        np.full_like(lons, lon_start), np.full_like(lats, lat_start), 
        lons, lats
    )
    
    #Project the distance along our specific tilt axis using cosine trigonometry
    angle_diff = np.radians(forward_azimuth - tilt_azimuth)
    projected_distance_km = (distance_meters / 1000.0) * np.cos(angle_diff)
    
    
    # This prevents the "south" cells from experiencing any elevation change.
    projected_distance_km = np.where(projected_distance_km < 0, 0, projected_distance_km)
    
    # Compute elevation adjustments (tilt_factor is in meters per kilometer)
    elevation_delta = projected_distance_km * tilt_factor
    
    # Return the newly modified landscape array
    return DEM_array - elevation_delta

def extract_strandline_contours(tilted_DEM, transform, target_elevation):
    """
    Extracts continuous strandline paths at a target paleo-elevation.
    Automatically translates pixel vectors back into geospatial coordinates.
    """
    # 1. Prevent contour artifacts by handling NaNs defensively.
    # Instead of an extreme value like -9999, we interpolate or use a value 
    # that won't create a false crossing. Better yet, create a boolean mask of the original NaNs.
    nan_mask = np.isnan(tilted_DEM)

    valid_values = tilted_DEM[~nan_mask]
    if valid_values.size == 0:
        raise ValueError("The DEM contains no valid (non-NaN) elevation data to contour.")

    valid_min = np.nanmin(valid_values)
    valid_max = np.nanmax(valid_values)
    if target_elevation < valid_min or target_elevation > valid_max:
        raise ValueError(
            f"Target elevation {target_elevation} is outside the DEM's valid elevation "
            f"range [{valid_min}, {valid_max}]."
        )

    # Fill NaNs with an extreme value away from target to ensure a crisp boundary,
    # but we will explicitly filter out contours that trace this mask boundary.
    clean_array = np.nan_to_num(tilted_DEM, nan=-99999.0)
    
    # 2. Extract raw pixel-space contours
    pixel_contours = measure.find_contours(clean_array, target_elevation)
    
    # Handle the empty edge case gracefully
    if not pixel_contours:
        warnings.warn(f"No strandlines found at target elevation: {target_elevation} meters.", UserWarning)
        return []
        
    geo_contours = []
    
    # 3. Transform pixel coordinates back to real-world Geographics (Lon/Lat)
    for contour in pixel_contours:
        # skimage returns coordinates as (row, col) float arrays
        rows = contour[:, 0]
        cols = contour[:, 1]
        
        # Verify if this contour is just tracing your artificial NaN boundary cliff
        # We sample the coordinates to see if they are touching the original missing data mask
        rounded_rows = np.clip(np.round(rows).astype(int), 0, tilted_DEM.shape[0] - 1)
        rounded_cols = np.clip(np.round(cols).astype(int), 0, tilted_DEM.shape[1] - 1)
        
        if np.any(nan_mask[rounded_rows, rounded_cols]):
            # Skip this contour line if it's hitting your data boundary edge
            continue

        #if len(contour) < 10:  # Skip paths that have fewer than 10 vertices
        #    continue
            
        # Use rasterio's fast vector transform to convert pixels to spatial coords
        lons, lats = rasterio.transform.xy(transform, rows, cols)
        
        # Zip them together into a clean NX2 coordinate array (Lon, Lat)
        geo_coordinates = np.column_stack((lons, lats))
        geo_contours.append(geo_coordinates)
        
    return geo_contours

"""
def extract_strandline_contours(tilted_DEM, target_elevation):
    # skimage expects a clean array without NaNs for contouring, so we handle that
    clean_array = np.nan_to_num(tilted_DEM, nan=-9999)
    
    # Find contours at the exact target paleo-lake level
    contours = measure.find_contours(clean_array, target_elevation)
    return contours
"""
# --- LOCAL TESTING BLOCK ---
if __name__ == "__main__":
    print("Testing GIA Engine backend components locally...")
    # Once you drop a test DEM into your folder, you can run this file directly:
    # dem, transform, crs = load_dem("test_data/modern_dem.tif")
    # modified_dem = calculate_gia_tilt(dem, transform, (-110.5, 45.2), 210, 0.1)
    # print("Success! Math executed without loops.")
