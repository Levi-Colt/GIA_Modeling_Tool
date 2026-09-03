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
                "peak_ram_mb": peak_ram_required_mb,
                "width": width,
                "height": height,
            }

    # Catch file corruption, invalid formats, or broken headers
    except rasterio.errors.RasterioIOError as e:
        raise IOError(
            f"Rasterio could not open '{DEM_path}'. The file may be corrupted, "
            f"truncated, or is an unsupported image format. Details: {e}"
        )


def largest_safe_tile_size(width, height, available_ram_mb, per_pixel_cost_bytes, safe_fraction=0.60):
    """
    Largest tile_size such that tile_size * width * per_pixel_cost_bytes <=
    available_ram_mb * safe_fraction, capped at min(width, height) -- i.e.
    degenerates to a single pass (no windowing subdivision at all) once the
    whole raster fits the budget as "one tile". Replaces the fixed 512/512/
    1024 defaults tilt_DEM_windowed / extract_strandline_contours_windowed /
    write_dem_to_gpkg_windowed used to hardcode independently (see
    documentation/PERFORMANCE_OPTIMIZATION_SPEC.md Fix 2).

    The same computed value is used both as calculate_tilt's row-strip
    chunk_rows and as the square tile_size for the windowed pipeline's three
    tile-streamed functions -- the row-strip cost model here is a
    conservative stand-in for the (smaller) square-tile cost, not a separate
    calculation, per the spec's "one sizing decision, reused everywhere" call.

    per_pixel_cost_bytes is specific to whichever operation is being sized
    (tilt / contour / gpkg-write each keep a different number of live
    intermediate arrays per pixel -- see the constants documented next to
    each call site in backend/app.py::process_dem) and is the caller's
    responsibility to supply, not derived here.
    """
    budget_bytes = available_ram_mb * (1024 ** 2) * safe_fraction
    bytes_per_row = max(width, 1) * per_pixel_cost_bytes
    tile_size = max(int(budget_bytes // bytes_per_row), 1)
    return min(tile_size, width, height)


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
        # Computed once against the FULL raster's extent, not each block's much
        # smaller one -- a block-local diagonal would wrongly force every block
        # onto the single-calibration path regardless of the raster's real size.
        diagonal_km = _raster_diagonal_km(src.transform, (src.height, src.width))
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
                        warn_if_disconnected=False, diagonal_km=diagonal_km,
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


RECALIBRATION_THRESHOLD_KM = 100.0
"""
Below this corner-to-corner raster diagonal, a single flat-plane calibration
point (the tilt origin) stays accurate to within roughly 5cm across the whole
extent -- extrapolated from a measured 9mm deviation from the true per-pixel
geodesic answer at a 44km diagonal (error grows roughly with the square of
distance from the calibration point). Not yet re-validated against a real
large-extent DEM -- see documentation/PERFORMANCE_OPTIMIZATION_SPEC.md Fix 1c.
"""

_CALIBRATION_DELTA_DEG = 0.01
"""Small step used to sample local meters-per-degree scale factors via
Geod.inv(), rather than a closed-form ellipsoid formula -- keeps calibration
consistent with Geod.inv()'s own reference geometry."""


def _raster_diagonal_km(transform, shape, geod=None):
    """
    Corner-to-corner geodesic distance across a raster's extent, in km.

    Assumes transform maps pixel space directly into geographic (lon/lat)
    degrees -- consistent with the rest of this module's CRS-naive contract
    (see api/crs.py's docstring: CRS handling is entirely the API layer's
    job, backend/main.py never reprojects). Used to decide calculate_tilt's
    calibration strategy (Fix 1c); NOT a general CRS-aware tool -- api/crs.py's
    get_raster_diagonal_km is the reprojection-aware equivalent /api/preflight
    uses for the raw, possibly-projected upload.
    """
    if geod is None:
        geod = Geod(ellps='WGS84')
    height, width = shape
    left, bottom, right, top = rasterio.transform.array_bounds(height, width, transform)
    _, _, dist_m = geod.inv(left, bottom, right, top)
    return dist_m / 1000.0


def _local_scale_factors(geod, lon0, lat0, delta_deg=_CALIBRATION_DELTA_DEG):
    """
    Meters per degree of longitude and latitude at (lon0, lat0), sampled via
    a small Geod.inv() step. Longitude's scale factor shrinks toward the
    poles (roughly cos(latitude)); latitude's is nearly constant.

    The latitude step direction flips near the north pole (lat0 + delta_deg
    would otherwise exceed the valid +90 bound) so this stays crash-free for
    an origin placed exactly at a pole; distance is direction-independent so
    dividing by the fixed positive delta_deg is correct either way.
    """
    lat_step = delta_deg if lat0 + delta_deg <= 90.0 else -delta_deg
    _, _, dist_lat_m = geod.inv(lon0, lat0, lon0, lat0 + lat_step)
    _, _, dist_lon_m = geod.inv(lon0, lat0, lon0 + delta_deg, lat0)
    return dist_lon_m / delta_deg, dist_lat_m / delta_deg


def _lonlat_grid(transform, row_offset, block_shape):
    """
    Longitude/latitude coordinates for a block_shape array whose row 0
    corresponds to full-raster row `row_offset` under `transform`.

    For a non-rotated (north-up) transform -- transform.b == transform.d ==
    0, true for virtually every real-world GeoTIFF -- longitude depends only
    on column and latitude only on row, so this returns two 1D arrays that
    broadcast into the full 2D grid rather than building it directly (Fix
    1a). Rotated transforms fall back to the original per-pixel affine
    mapping at full 2D cost, so correctness doesn't depend on how rare that
    case actually is.

    Returns (lons, lats) -- either broadcastable 1D arrays (shape (1, width)
    / (height, 1)) or, for the rotated fallback, already-full 2D arrays.
    """
    block_height, width = block_shape
    if transform.b == 0 and transform.d == 0:
        cols = np.arange(width)
        rows = np.arange(row_offset, row_offset + block_height)
        lons = transform.a * (cols + 0.5) + transform.c
        lats = transform.e * (rows + 0.5) + transform.f
        return lons[np.newaxis, :], lats[:, np.newaxis]

    rr, cc = np.indices(block_shape)
    lons, lats = rasterio.transform.xy(transform, rr + row_offset, cc)
    lons = np.array(lons).reshape(block_shape)
    lats = np.array(lats).reshape(block_shape)
    return lons, lats


def _tilt_block(block, transform, row_offset, origin_coords, tilt_azimuth, tilt_factor,
                 diagonal_km, geod):
    """
    Computes the tilted elevation for one row-strip (or the whole array, if
    it isn't being chunked) -- the calibrated flat-plane replacement for the
    old per-pixel Geod.inv() call (Fix 1b/1c). See calculate_tilt's own
    docstring for the public contract.
    """
    lon0, lat0 = origin_coords
    lons, lats = _lonlat_grid(transform, row_offset, block.shape)
    m_per_deg_lon0, m_per_deg_lat0 = _local_scale_factors(geod, lon0, lat0)

    if diagonal_km < RECALIBRATION_THRESHOLD_KM:
        m_per_deg_lon = m_per_deg_lon0
    else:
        # Meters-per-degree-of-longitude shrinks toward the poles roughly as
        # cos(latitude) -- re-deriving it per row keeps calibration accurate
        # across a large latitude span instead of just near the origin.
        # meters-per-degree-of-LATITUDE varies far less across the ellipsoid
        # (well under 1%), so m_per_deg_lat0 alone stays accurate throughout.
        #
        # This replaces the spec's originally-proposed concentric
        # distance-bands (calibrated along the tilt-azimuth ray at each
        # band's midpoint): implemented and measured against a true per-pixel
        # geodesic reference on a synthetic 423km-diagonal grid, that scheme
        # did NOT reduce error at any band granularity (~7m worst-case
        # regardless of band width) -- because the real error driver is
        # latitude, not radial distance from the origin, and a radial band
        # still spans a full ring of latitudes. This per-row cosine
        # correction matches an exact per-row Geod.inv() recalibration to
        # within ~0.05m on that same test grid, at effectively zero added
        # cost (one more elementwise np.cos(), not extra Geod calls) -- the
        # residual ~1.5m at 423km is the flat-plane model's own floor
        # (meridian convergence no per-row scale factor can capture), not a
        # calibration gap. See documentation/PERFORMANCE_OPTIMIZATION_SPEC.md
        # Fix 1c.
        m_per_deg_lon = m_per_deg_lon0 * np.cos(np.radians(lats)) / np.cos(np.radians(lat0))

    east_km = (lons - lon0) * m_per_deg_lon / 1000.0
    north_km = (lats - lat0) * m_per_deg_lat0 / 1000.0

    # Projection of the (east_km, north_km) vector onto the tilt azimuth's own
    # unit vector -- equivalent to distance * cos(bearing_to_pixel - tilt_azimuth)
    # from the original per-pixel formula, without needing bearing or distance
    # as separate quantities.
    tilt_rad = np.radians(tilt_azimuth)
    projected_distance_km = east_km * np.sin(tilt_rad) + north_km * np.cos(tilt_rad)

    # This prevents the "south" cells from experiencing any elevation change.
    projected_distance_km = np.where(projected_distance_km < 0, 0, projected_distance_km)

    # Compute elevation adjustments (tilt_factor is in meters per kilometer)
    elevation_delta = projected_distance_km * tilt_factor

    # Return the newly modified landscape block
    return block - elevation_delta


def calculate_tilt(DEM_array, transform, origin_coords, tilt_azimuth, tilt_factor,
                    warn_if_disconnected=True, diagonal_km=None, chunk_rows=None):
    """
    Applies a directional planar downward tilt across a DEM starting from an origin point.
    Cells in the direction of the tilt azimuth are adjusted linearly.
    Cells behind the tilt plane baseline experience zero change.

    Uses a locally-calibrated flat-plane approximation rather than a
    per-pixel ellipsoidal geodesic solve (documentation/PERFORMANCE_OPTIMIZATION_SPEC.md
    Fix 1b) -- max ~9mm deviation from the true per-pixel geodesic answer at a
    44km diagonal, two orders of magnitude below this tool's own precision.
    diagonal_km controls whether that's a single calibration point (below
    RECALIBRATION_THRESHOLD_KM) or a banded recalibration across concentric
    distance-bands from the origin (Fix 1c); if not supplied, it's computed
    from `transform`/`DEM_array.shape` -- correct only when those describe
    the FULL raster, not a sub-block, which is why tilt_DEM_windowed computes
    and threads it through explicitly instead of relying on this default.

    chunk_rows processes the array in row-strips of that height rather than
    all at once, bounding this function's own intermediate-array memory to a
    small multiple of chunk_rows x width regardless of the full raster's
    size (Fix 1, "chunk internally regardless of extent size"). None (the
    default) processes the whole array in one pass.

    warn_if_disconnected: set to False when calling this per-block from a windowed
    pipeline, since a block's local extent will rarely contain the origin even when
    the full raster does; the windowed caller performs this check once, upfront,
    against the full raster extent instead.
    """
    if warn_if_disconnected:
        _warn_if_origin_disconnected(transform, DEM_array.shape, origin_coords)

    geod = Geod(ellps='WGS84')
    if diagonal_km is None:
        diagonal_km = _raster_diagonal_km(transform, DEM_array.shape, geod=geod)

    height = DEM_array.shape[0]
    if not chunk_rows or chunk_rows >= height:
        return _tilt_block(DEM_array, transform, 0, origin_coords, tilt_azimuth, tilt_factor,
                            diagonal_km, geod)

    out = np.empty_like(DEM_array, dtype='float32')
    for row_start in range(0, height, chunk_rows):
        row_end = min(row_start + chunk_rows, height)
        out[row_start:row_end] = _tilt_block(
            DEM_array[row_start:row_end], transform, row_start, origin_coords, tilt_azimuth,
            tilt_factor, diagonal_km, geod,
        )
    return out

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
