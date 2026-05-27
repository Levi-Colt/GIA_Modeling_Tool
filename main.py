import numpy as np
import rasterio
import os
import warnings
from pyproj import Geod
from skimage import measure


def load_DEM(DEM_path):
    #Verify file path existence
    if not os.path.exists(DEM_path):
        raise FileNotFoundError(f"The specified DEM file could not be found at: '{DEM_path}'")
        
    try:
        with rasterio.open(DEM_path) as src:

            if src.count > 1:
                warnings.warn(
                    f"Warning: The raster at '{DEM_path}' contains {src.count} bands. "
                    "This tool will proceed using Band 1 for calculations. "
                    "Please ensure your input is a valid DEM with elevation data in Band 1.",
                    UserWarning
                )

            DEM_array = src.read(1).astype('float32')
            transform = src.transform
            crs = src.crs
            
            #Check for nodata and handle warnings/masking
            nodata = src.nodata
            if nodata is not None:
                DEM_array = np.where(DEM_array == nodata, np.nan, DEM_array)
            else:
                warnings.warn(
                    f"Warning: The raster at '{DEM_path}' does not have a defined 'nodata' value. "
                    "Edges or missing data regions may distort GIA calculations.",
                    UserWarning
                )
                
        return DEM_array, transform, crs

    #Catch general Rasterio open errors (e.g., file is corrupted or not a valid GeoTIFF)
    except rasterio.errors.RasterioIOError as e:
        raise IOError(f"Failed to read the file at '{DEM_path}'. It may be corrupted or an invalid format. Details: {e}")

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