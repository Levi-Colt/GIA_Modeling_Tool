import numpy as np
import rasterio
from pyproj import Geod
from skimage import measure


def load_DEM(dem_path):
    with rasterio.open(dem_path) as src:
        DEM_array = src.read(1)
        transform = src.transform
        crs = src.crs
        
        # Handle nodata values gracefully so they don't mess up math
        nodata = src.nodata
        DEM_array = np.where(DEM_array == nodata, np.nan, DEM_array)
        
    return DEM_array, transform, crs

def calculate_tilt(DEM_array, transform, origin_coords, tilt_azimuth, tilt_factor):
    geod = Geod(ellps='WGS84')
    lon_start, lat_start = origin_coords
    
    # Generate the coordinate grid using the raster's affine transform
    rows, cols = np.indices(DEM_array.shape)
    lons, lats = rasterio.transform.xy(transform, rows, cols)
    lons = np.array(lons)
    lats = np.array(lats)
    
    # Calculate curved-earth distance and direction to every single pixel
    forward_azimuth, _, distance_meters = geod.inv(
        np.full_like(lons, lon_start), np.full_like(lats, lat_start), 
        lons, lats
    )
    
    # Project the distance along our specific tilt axis
    angle_diff = np.radians(forward_azimuth - tilt_azimuth)
    projected_distance_km = (distance_meters / 1000.0) * np.cos(angle_diff)
    
    # Compute elevation adjustments (tilt_factor is in meters per kilometer)
    elevation_delta = projected_distance_km * tilt_factor
    
    # Return the newly modified "untilted" landscape array
    return DEM_array + elevation_delta

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