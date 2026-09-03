import os
import tempfile

import geopandas as gpd
from shapely.geometry import LineString, MultiLineString

from backend.main import (
    check_available_ram_mb,
    raster_io_check,
    largest_safe_tile_size,
    load_DEM,
    calculate_tilt,
    extract_strandline_contours,
    tilt_DEM_windowed,
    extract_strandline_contours_windowed,
    write_dem_to_gpkg,
    write_dem_to_gpkg_windowed,
)

# Fix 2 (documentation/PERFORMANCE_OPTIMIZATION_SPEC.md) -- per-pixel memory
# cost estimates for largest_safe_tile_size, one per windowed operation.
# Estimated from each function's own live intermediate-array count following
# Fix 1's rewrite, not yet profiled against a real large file in this
# environment (the spec's own note: measure these empirically during
# implementation) -- revisit with real CryoCloud profiling before trusting
# these at the extremes.
#   TILT: input block (float32, 4B) + output block (float32, 4B) +
#     projected_distance_km / elevation_delta (float64, 8B each, materialized
#     at the final broadcast step) = ~32B/pixel. Same cost model for
#     calculate_tilt's chunk_rows and tilt_DEM_windowed's tile_size, since
#     both run the same per-pixel math.
#   CONTOUR: padded block (float32, 4B) + nan_mask (bool, 1B) + clean_array
#     (float32, 4B) + skimage's internal marching-squares working buffer
#     (~2x input, 8B) = ~24B/pixel, rounded up for halo padding overhead.
#   GPKG_WRITE: block read (float32, 4B) + GDAL's own write buffer (~4B) =
#     ~8B/pixel.
TILT_BYTES_PER_PIXEL = 32
CONTOUR_BYTES_PER_PIXEL = 24
GPKG_WRITE_BYTES_PER_PIXEL = 8

# Fix 3 (documentation/PERFORMANCE_OPTIMIZATION_SPEC.md) -- drop nodata-
# boundary/noise artifacts (very few vertices) and simplify the legitimate
# remainder, both for smaller .gpkg output and because this same geometry
# gets serialized to GeoJSON and rendered client-side (see
# VISUALIZATION_PIPELINE_SPEC.md Stage 3). MIN_CONTOUR_VERTICES is a
# conservative reading of the abandoned `if len(contour) < 10` filter noted
# in main.py's extract_strandline_contours (picked lower than that original
# 10 specifically to avoid dropping short-but-legitimate contours); the
# simplify tolerance is a first-pass default (~1m at the equator), not yet
# empirically tuned against a real large contour set.
MIN_CONTOUR_VERTICES = 4
CONTOUR_SIMPLIFY_TOLERANCE_DEG = 1e-5


def _as_line_list(geometry):
    """
    Normalizes a shapely geometry into a flat list of LineStrings.

    extract_strandline_contours_windowed runs its fragments through
    shapely.ops.linemerge, which returns a single LineString when everything
    merges into one continuous path, or a MultiLineString when there are
    multiple disjoint pieces -- NOT always a MultiLineString. Treating the
    result as always having a `.geoms` attribute crashes (AttributeError)
    on the single-continuous-strandline case, which is the common case, not
    an edge case.
    """
    if geometry.is_empty:
        return []
    if isinstance(geometry, MultiLineString):
        return list(geometry.geoms)
    return [geometry]


#Simulation of your execution runtime or FastAPI Route handler
def process_dem(file_path, origin_coords, tilt_azimuth, tilt_factor,
                 target_elevation, output_gpkg_path, include_dem=True):
    print("--- Starting GIA Processing ---")

    # Ensure the output directory exists, and start from a clean output file.
    # write_dem_to_gpkg/write_dem_to_gpkg_windowed each guard against a stale
    # file when include_dem=True (see their own overwrite parameter), but
    # this guard is still needed for the include_dem=False path, where
    # neither is ever called and nothing else would clean up a prior run's
    # leftover output_gpkg_path before gdf.to_file() below.
    output_dir = os.path.dirname(output_gpkg_path)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
    if os.path.exists(output_gpkg_path):
        os.remove(output_gpkg_path)

    #Check system constraints dynamically
    free_ram = check_available_ram_mb()
    print(f"Current Environment Available RAM: {free_ram:.2f} MB")

    #Analyze the input file against the live constraints
    io_strategy = raster_io_check(file_path, free_ram)
    print(f"File Analysis complete. Peak processing memory requirement: {io_strategy['peak_ram_mb']:.2f} MB")

    needs_casting = io_strategy["needs_casting"]
    band_count = io_strategy["band_count"]
    width, height = io_strategy["width"], io_strategy["height"]

    #Route execution branch based on the configuration flag
    if io_strategy["use_windowed_io"]:
        print("ALERT: File memory footprint exceeds safe RAM threshold. Using windowed pipeline.")
        tilt_tile_size = largest_safe_tile_size(width, height, free_ram, TILT_BYTES_PER_PIXEL)
        contour_tile_size = largest_safe_tile_size(width, height, free_ram, CONTOUR_BYTES_PER_PIXEL)
        gpkg_tile_size = largest_safe_tile_size(width, height, free_ram, GPKG_WRITE_BYTES_PER_PIXEL)
        with tempfile.NamedTemporaryFile(suffix=".tif", delete=False) as tmp:
            tilted_path = tmp.name
        try:
            tilted_path, tilted_transform, crs = tilt_DEM_windowed(
                file_path, tilted_path, origin_coords, tilt_azimuth, tilt_factor,
                tile_size=tilt_tile_size,
            )
            contours = extract_strandline_contours_windowed(
                tilted_path, target_elevation, tile_size=contour_tile_size,
            )
            if include_dem:
                write_dem_to_gpkg_windowed(tilted_path, output_gpkg_path, tile_size=gpkg_tile_size)
            lines = _as_line_list(contours)
        finally:
            if os.path.exists(tilted_path):
                os.remove(tilted_path)
    else:
        print("PASS: File is safe for standard in-memory operations.")
        dem_array, transform, crs = load_DEM(file_path, needs_casting, band_count)
        print(f"Successfully loaded array with shape {dem_array.shape} into system memory.")
        chunk_rows = largest_safe_tile_size(width, height, free_ram, TILT_BYTES_PER_PIXEL)
        tilted_array = calculate_tilt(
            dem_array, transform, origin_coords, tilt_azimuth, tilt_factor, chunk_rows=chunk_rows,
        )
        contours = extract_strandline_contours(tilted_array, transform, target_elevation)
        if include_dem:
            write_dem_to_gpkg(tilted_array, transform, crs, output_gpkg_path)
        lines = [LineString(c) for c in contours]

    # Drop nodata-boundary/noise artifacts, then simplify the legitimate
    # remainder (Fix 3) -- applied here, after both branches converge on a
    # final list of LineStrings, rather than inside extract_strandline_contours
    # itself, so a fragment that crosses several windowed-pipeline tile
    # boundaries is judged by its final assembled length, not by any one
    # tile's fragment of it.
    lines = [line for line in lines if len(line.coords) >= MIN_CONTOUR_VERTICES]
    lines = [line.simplify(CONTOUR_SIMPLIFY_TOLERANCE_DEG, preserve_topology=False) for line in lines]

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
