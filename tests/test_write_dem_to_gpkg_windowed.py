"""
Equivalence test between write_dem_to_gpkg (whole-array) and
write_dem_to_gpkg_windowed (tile-streamed). Windowing here is meant purely as
a memory-management strategy, not a different output, so given the same
input the two should produce numerically identical GeoPackage raster tables.
Follows the same equivalence-testing pattern as tests/test_pipeline_equivalence.py.

This is also the first exercise of GDAL's GPKG raster driver under windowed
`dst.write(block, 1, window=window)` calls in this codebase -- untested
territory per TARGET_ELEVATION_AND_GPKG_TASKS.md Task 7, hence this test's
existence rather than trusting the implementation on inspection alone.
"""
import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from main import write_dem_to_gpkg, write_dem_to_gpkg_windowed

GRID = 40
PIXEL = 0.005


@pytest.fixture
def large_transform():
    return from_origin(-105.0, 45.0, PIXEL, PIXEL)


@pytest.fixture
def large_dem_array():
    # A DEM large enough, with a tile_size small enough below, that the
    # windowed writer actually spans multiple tiles rather than passing
    # through in one block.
    y, x = np.indices((GRID, GRID))
    return (y * 10.0 + x * 5.0).astype("float32")


@pytest.fixture
def large_dem_path(tmp_path, large_transform, large_dem_array):
    path = tmp_path / "large_dem.tif"
    profile = {
        "driver": "GTiff", "height": GRID, "width": GRID, "count": 1,
        "dtype": "float32", "crs": "EPSG:4326", "transform": large_transform,
        "nodata": -9999.0,
    }
    with rasterio.open(str(path), "w", **profile) as dst:
        dst.write(large_dem_array, 1)
    return str(path)


def test_windowed_write_matches_whole_array_write(large_dem_array, large_transform, large_dem_path, tmp_path):
    whole_path = str(tmp_path / "whole.gpkg")
    windowed_path = str(tmp_path / "windowed.gpkg")

    write_dem_to_gpkg(large_dem_array, large_transform, "EPSG:4326", whole_path)
    write_dem_to_gpkg_windowed(large_dem_path, windowed_path, tile_size=16)

    with rasterio.open(f"GPKG:{whole_path}:modified_dem") as src:
        whole_array = src.read(1)
        whole_transform = src.transform
    with rasterio.open(f"GPKG:{windowed_path}:modified_dem") as src:
        windowed_array = src.read(1)
        windowed_transform = src.transform

    np.testing.assert_array_equal(whole_array, windowed_array)
    assert whole_transform == windowed_transform


def test_windowed_write_respects_custom_table_name(large_dem_path, tmp_path):
    path = str(tmp_path / "dem.gpkg")
    write_dem_to_gpkg_windowed(large_dem_path, path, table_name="custom_layer", tile_size=16)

    with rasterio.open(f"GPKG:{path}:custom_layer") as src:
        assert src.height == GRID and src.width == GRID


def test_overwrite_false_restores_strict_raise_behavior(large_dem_path, tmp_path):
    path = str(tmp_path / "dem.gpkg")
    write_dem_to_gpkg_windowed(large_dem_path, path, overwrite=False)
    with pytest.raises(rasterio.errors.RasterioIOError):
        write_dem_to_gpkg_windowed(large_dem_path, path, overwrite=False)


def test_overwrite_true_replaces_prior_file(large_dem_path, large_dem_array, tmp_path):
    path = str(tmp_path / "dem.gpkg")
    write_dem_to_gpkg_windowed(large_dem_path, path, tile_size=16)
    write_dem_to_gpkg_windowed(large_dem_path, path, tile_size=16)  # default overwrite=True

    with rasterio.open(f"GPKG:{path}:modified_dem") as src:
        np.testing.assert_array_equal(src.read(1), large_dem_array)
