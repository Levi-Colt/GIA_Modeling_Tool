import os
import tempfile
import warnings

import rasterio
import geopandas as gpd
from shapely.geometry import LineString

from main import (
    check_available_ram_mb,
    raster_io_check,
    load_DEM,
    calculate_tilt,
    extract_strandline_contours,
    tilt_DEM_windowed,
    extract_strandline_contours_windowed,
    write_dem_to_gpkg,
)


#Simulation of your execution runtime or FastAPI Route handler
def process_dem(file_path, origin_coords, tilt_azimuth, tilt_factor,
                 target_elevation, output_gpkg_path, include_dem=True):
    print("--- Starting GIA Processing ---")

    #Check system constraints dynamically
    free_ram = check_available_ram_mb()
    print(f"Current Environment Available RAM: {free_ram:.2f} MB")

    #Analyze the input file against the live constraints
    io_strategy = raster_io_check(file_path, free_ram)
    print(f"File Analysis complete. Peak processing memory requirement: {io_strategy['peak_ram_mb']:.2f} MB")

    needs_casting = io_strategy["needs_casting"]
    band_count = io_strategy["band_count"]

    #Route execution branch based on the configuration flag
    if io_strategy["use_windowed_io"]:
        print("ALERT: File memory footprint exceeds safe RAM threshold. Using windowed pipeline.")
        with tempfile.NamedTemporaryFile(suffix=".tif", delete=False) as tmp:
            tilted_path = tmp.name
        tilted_path, tilted_transform, crs = tilt_DEM_windowed(
            file_path, tilted_path, origin_coords, tilt_azimuth, tilt_factor
        )
        contours = extract_strandline_contours_windowed(tilted_path, target_elevation)
        if include_dem:
            with rasterio.open(tilted_path) as src:
                write_dem_to_gpkg(src.read(1), tilted_transform, crs, output_gpkg_path)
        os.remove(tilted_path)
        lines = list(contours.geoms)
    else:
        print("PASS: File is safe for standard in-memory operations.")
        dem_array, transform, crs = load_DEM(file_path, needs_casting, band_count)
        print(f"Successfully loaded array with shape {dem_array.shape} into system memory.")
        tilted_array = calculate_tilt(dem_array, transform, origin_coords, tilt_azimuth, tilt_factor)
        contours = extract_strandline_contours(tilted_array, transform, target_elevation)
        if include_dem:
            write_dem_to_gpkg(tilted_array, transform, crs, output_gpkg_path)
        lines = [LineString(c) for c in contours]

    # Contours -> vector layer, same gpkg file either branch
    gdf = gpd.GeoDataFrame(geometry=lines, crs=crs)
    gdf.to_file(output_gpkg_path, layer="strandline_contour", driver="GPKG")

    print(f"--- Complete. Output written to {output_gpkg_path} ---")
    return output_gpkg_path


# --- Local Verification ---
if __name__ == "__main__":
    # Ensure you've run: pip install psutil rasterio geopandas shapely
    # process_dem(
    #     file_path="test_data/my_dem.tif",
    #     origin_coords=(-110.5, 45.2),
    #     tilt_azimuth=210,
    #     tilt_factor=0.1,
    #     target_elevation=1200,
    #     output_gpkg_path="output/strandlines.gpkg",
    #     include_dem=True,
    # )
    pass
