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

from backend.main import (
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


def _write_dem(path, array, transform):
    profile = {
        "driver": "GTiff", "height": array.shape[0], "width": array.shape[1], "count": 1,
        "dtype": "float32", "crs": "EPSG:4326", "transform": transform, "nodata": -9999.0,
    }
    with rasterio.open(str(path), "w", **profile) as dst:
        dst.write(array, 1)
    return str(path)


@pytest.mark.parametrize("grid,pixel,origin", [
    (GRID, PIXEL, TILT_ORIGIN),                    # ~22 km diagonal: single calibration
    (150, 0.01, (-104.25, 44.25)),                 # ~200 km diagonal: per-row cos(lat)
])
def test_windowed_quadratic_guard_clamp_matches_in_memory(tmp_path, grid, pixel, origin):
    # A concave-up quadratic with hinge mode 'none', so the zero-gradient guard
    # (-g0/k = -10 km) sets the clamp INSIDE the raster: blocks on both sides of
    # it -- and blocks it cuts through -- are exercised. The clamp is resolved
    # once at build time, so windowed and in-memory runs must agree.
    from backend.uplift import build_uplift_model

    transform = from_origin(ORIGIN_LON, ORIGIN_LAT, pixel, pixel)
    y, x = np.indices((grid, grid))
    dem = (1000.0 - 0.5 * x - 0.25 * y).astype("float32")
    dem_path = _write_dem(tmp_path / "dem.tif", dem, transform)

    spec = {
        "version": 1, "direction": {"type": "azimuth"},
        "profile": {"family": "quadratic", "rate_of_increase": 0.3, "coefficients": None},
        "hinge": {"mode": "none", "distance_km": None},
    }
    model = build_uplift_model(spec, 28.0, 3.0)
    assert model.hinge_d == pytest.approx(-10.0)
    assert model.hinge_source == "guard"

    in_memory = calculate_tilt(dem, transform, origin, 28.0, 3.0, uplift_model=model)
    chunked = calculate_tilt(dem, transform, origin, 28.0, 3.0, uplift_model=model, chunk_rows=13)
    out_path = str(tmp_path / "windowed.tif")
    tilt_DEM_windowed(dem_path, out_path, origin, 28.0, 3.0, tile_size=16, uplift_model=model)
    with rasterio.open(out_path) as src:
        windowed = src.read(1)

    np.testing.assert_allclose(windowed, in_memory, rtol=1e-6, atol=1e-3)
    np.testing.assert_allclose(chunked, in_memory, rtol=1e-6, atol=1e-3)
    # The model actually did something beyond the basic tilt.
    basic = calculate_tilt(dem, transform, origin, 28.0, 3.0)
    assert np.abs(in_memory - basic).max() > 1.0


def test_uplift_model_takes_precedence_over_azimuth_and_factor(large_dem_array, large_transform):
    from backend.uplift import linear_planar_model

    model = linear_planar_model(90.0, 2.0)
    via_model = calculate_tilt(large_dem_array, large_transform, TILT_ORIGIN, 0.0, 99.0, uplift_model=model)
    direct = calculate_tilt(large_dem_array, large_transform, TILT_ORIGIN, 90.0, 2.0)
    assert np.array_equal(via_model, direct)


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
