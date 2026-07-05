"""
Equivalence tests between the standard (in-memory) and windowed (block-streamed)
pipelines. Windowing is meant to be purely a memory-management strategy, not a
different algorithm -- given the same DEM, both paths should produce the same
scientific result. These tests use a DEM large enough, and a small enough tile
size, that the windowed path actually exercises its tiling/halo-stitching
logic rather than just passing through in one block.
"""
import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import LineString, MultiLineString
from shapely.ops import linemerge

from main import (
    calculate_tilt,
    extract_strandline_contours,
    tilt_DEM_windowed,
    extract_strandline_contours_windowed,
)

GRID = 40
PIXEL = 0.005
ORIGIN_LON = -105.0
ORIGIN_LAT = 45.0
TILT_ORIGIN = (-104.95, 44.95)  # roughly the center of the grid


@pytest.fixture
def large_transform():
    return from_origin(ORIGIN_LON, ORIGIN_LAT, PIXEL, PIXEL)


@pytest.fixture
def large_dem_array():
    """
    A radial "dome" centered on the grid, so a mid-range target elevation
    crosses it as a closed ring spanning multiple tiles -- more representative
    of a real strandline than a simple linear gradient.
    """
    y, x = np.indices((GRID, GRID))
    center = GRID / 2
    radius = np.sqrt((x - center) ** 2 + (y - center) ** 2)
    return (1000.0 - radius * 20.0).astype("float32")


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


def test_windowed_tilt_matches_standard_tilt(large_dem_array, large_transform, large_dem_path, tmp_path):
    standard_tilted = calculate_tilt(
        large_dem_array, large_transform, TILT_ORIGIN, tilt_azimuth=45, tilt_factor=3.0
    )

    windowed_output = str(tmp_path / "tilted_windowed.tif")
    out_path, out_transform, out_crs = tilt_DEM_windowed(
        large_dem_path, windowed_output, TILT_ORIGIN, tilt_azimuth=45, tilt_factor=3.0,
    )
    with rasterio.open(out_path) as src:
        windowed_tilted = src.read(1)

    np.testing.assert_allclose(windowed_tilted, standard_tilted, rtol=1e-4, atol=1e-3)


def test_windowed_contours_match_standard_contours(large_dem_array, large_transform, large_dem_path, tmp_path):
    target_elevation = 700.0  # crosses the radial dome as a ring, away from any edge

    standard_contours = extract_strandline_contours(large_dem_array, large_transform, target_elevation)
    assert standard_contours, "test DEM should produce at least one contour at this target"
    standard_lines = [LineString(c) for c in standard_contours]
    standard_merged = linemerge(MultiLineString(standard_lines))

    # tilt_factor=0 keeps the geometry unchanged, isolating this test to the
    # contour tiling/stitching logic specifically (already covered separately
    # by test_windowed_tilt_matches_standard_tilt above).
    windowed_output = str(tmp_path / "flat_tilt_windowed.tif")
    tilt_DEM_windowed(large_dem_path, windowed_output, TILT_ORIGIN, tilt_azimuth=0, tilt_factor=0.0)

    windowed_merged = extract_strandline_contours_windowed(
        windowed_output, target_elevation, tile_size=16, halo=4,
    )
    assert not windowed_merged.is_empty

    # Compare total contour length and bounding boxes rather than exact vertex
    # ordering, since the two code paths trace and stitch geometry differently
    # but should still describe the same physical strandline.
    assert standard_merged.length == pytest.approx(windowed_merged.length, rel=0.05)
    for standard_bound, windowed_bound in zip(standard_merged.bounds, windowed_merged.bounds):
        assert standard_bound == pytest.approx(windowed_bound, abs=PIXEL * 2)
