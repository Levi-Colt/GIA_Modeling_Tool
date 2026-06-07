from main import (
    check_available_ram_mb,
    raster_io_check,
    load_DEM,
    load_DEM_windowed
)
import os
import warnings

#Simulation of your execution runtime or FastAPI Route handler
def process_dem(file_path):
    print("--- Starting GIA Processing ---")
    
    #Check system constraints dynamically
    free_ram = check_available_ram_mb()
    print(f"Current Environment Available RAM: {free_ram:.2f} MB")
    
    #Analyze the input file against the live constraints
    io_strategy = raster_io_check(file_path, free_ram)
    print(f"File Analysis complete. Peak processing memory requirement: {io_strategy['peak_ram_mb']:.2f} MB")
    
    # Extract structural configuration flags
    needs_casting = io_strategy["needs_casting"]
    band_count = io_strategy["band_count"]
    
    #Route execution branch based on the configuration flag
    if io_strategy["use_windowed_io"]:
        print("ALERT: File memory footprint exceeds safe RAM threshold.")
        result = load_DEM_windowed(file_path, needs_casting, band_count)
    else:
        print("PASS: File is safe for standard in-memory operations.")
        dem_array, transform, crs = load_DEM(file_path, needs_casting, band_count)
        print(f"Successfully loaded array with shape {dem_array.shape} into system memory.")
        result = "STANDARD_LOAD_SUCCESS"
        
    return result

# --- Local Verification ---
if __name__ == "__main__":
    # Ensure you've run: pip install psutil
    # process_dem_pipeline("test_data/my_dem.tif")
    pass