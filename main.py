import numpy as np
import rasterio
import os
import warnings
import psutil
from pyproj import Geod
from skimage import measure

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
        
    #Defensive I/O trapping
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
                
            if needs_casting:
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


def load_DEM_windowed(DEM_path, needs_casting, band_count):
    """
    Placeholder for specialized windowed reading logic.
    Called when files exceed the system RAM safety margin.
    """
    print(f"[Windowed Engine] Processing {DEM_path} sequentially in blocks...")
    # Windowed loop execution goes here
    return "WINDOWED_STREAM_SUCCESS"


def calculate_tilt(DEM_array, transform, origin_coords, tilt_azimuth, tilt_factor):
    """
    Applies a directional planar downward tilt across a DEM starting from an origin point.
    Cells in the direction of the tilt azimuth are adjusted linearly.
    Cells behind the tilt plane baseline experience zero change.
    """
    geod = Geod(ellps='WGS84')
    lon_start, lat_start = origin_coords
    
    #Generate the coordinate grid using the raster's affine transform
    rows, cols = np.indices(DEM_array.shape)
    lons, lats = rasterio.transform.xy(transform, rows, cols)
    lons = np.array(lons)
    lats = np.array(lats)
    
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

def extract_strandline_contours(tilted_DEM, target_elevation):
    # skimage expects a clean array without NaNs for contouring, so we handle that
    clean_array = np.nan_to_num(tilted_DEM, nan=-9999)
    
    # Find contours at the exact target paleo-lake level
    contours = measure.find_contours(clean_array, target_elevation)
    return contours

# --- LOCAL TESTING BLOCK ---
if __name__ == "__main__":
    print("Testing GIA Engine backend components locally...")
    # Once you drop a test DEM into your folder, you can run this file directly:
    # dem, transform, crs = load_dem("test_data/modern_dem.tif")
    # modified_dem = calculate_gia_tilt(dem, transform, (-110.5, 45.2), 210, 0.1)
    # print("Success! Math executed without loops.")