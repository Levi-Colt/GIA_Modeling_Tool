"""
Unit tests for main.extract_strandline_contours_windowed, in isolation from
the standard extract_strandline_contours pipeline (see
test_pipeline_equivalence.py for tests that compare the two directly).
"""
import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin
from shapely.geometry import MultiLineString

from main import extract_strandline_contours_windowed, tilt_DEM_windowed


def _write_dem(path, array, transform, nodata=-9999.0):
    profile = {
        "driver": "GTiff", "height": array.shape[0], "width": array.shape[1], "count": 1,
        "dtype": "float32", "crs": "EPSG:4326", "transform": transform, "nodata": nodata,
    }
    with rasterio.open(str(path), "w", **profile) as dst:
        dst.write(array, 1)
    return str(path)


def test_contours_positive_elevation_gradient(tmp_path):
    transform = from_origin(-105.0, 45.0, 0.01, 0.01)
    row = np.arange(10, dtype="float32") * 100.0
    array = np.tile(row, (10, 1))
    path = _write_dem(tmp_path / "dem.tif", array, transform)

    merged = extract_strandline_contours_windowed(path, target_elevation=450, tile_size=1024, halo=32)
    assert not merged.is_empty


def test_contours_negative_elevation_gradient(tmp_path):
    transform = from_origin(-105.0, 45.0, 0.01, 0.01)
    row = (np.arange(10, dtype="float32") * 100.0) - 1000.0  # -1000..-100
    array = np.tile(row, (10, 1))
    path = _write_dem(tmp_path / "dem.tif", array, transform)

    merged = extract_strandline_contours_windowed(path, target_elevation=-550, tile_size=1024, halo=32)
    assert not merged.is_empty


def test_big_elevation_gap_still_produces_interpolated_contour(tmp_path):
    transform = from_origin(-105.0, 45.0, 0.01, 0.01)
    array = np.zeros((10, 10), dtype="float32")
    array[:, 5:] = 1000.0
    path = _write_dem(tmp_path / "dem.tif", array, transform)

    merged = extract_strandline_contours_windowed(path, target_elevation=500, tile_size=1024, halo=32)
    assert not merged.is_empty


def test_all_nan_tile_does_not_crash_and_returns_empty(tmp_path):
    transform = from_origin(-105.0, 45.0, 0.01, 0.01)
    array = np.full((10, 10), np.nan, dtype="float32")
    path = _write_dem(tmp_path / "dem.tif", array, transform)

    merged = extract_strandline_contours_windowed(path, target_elevation=100, tile_size=1024, halo=32)
    assert merged.is_empty


def test_target_valid_for_whole_raster_but_out_of_range_for_some_tiles(tmp_path):
    # Regression test for a real bug: extract_strandline_contours validates
    # target_elevation against the LOCAL min/max of whatever array it's
    # handed. Called per-tile, that means a target perfectly valid for the
    # raster overall can still be outside a given tile's local range --
    # which is the normal case for any DEM with real elevation variation,
    # not an edge case. This must not raise; tiles where the target is out
    # of local range simply contribute no contour.
    transform = from_origin(-105.0, 45.0, 0.005, 0.005)
    grid = 40
    row = np.arange(grid, dtype="float32") * 30.0  # 0..1170 across columns
    array = np.tile(row, (grid, 1))
    path = _write_dem(tmp_path / "varying_dem.tif", array, transform)

    # 50.0 is valid for the whole raster (range 0..1170) but only appears in
    # the first couple of tile-columns when tiled this small.
    merged = extract_strandline_contours_windowed(path, target_elevation=50.0, tile_size=8, halo=2)
    assert not merged.is_empty


def test_returns_shapely_geometry(tmp_path):
    transform = from_origin(-105.0, 45.0, 0.01, 0.01)
    row = np.arange(10, dtype="float32") * 100.0
    array = np.tile(row, (10, 1))
    path = _write_dem(tmp_path / "dem.tif", array, transform)

    result = extract_strandline_contours_windowed(path, target_elevation=450, tile_size=1024, halo=32)
    assert hasattr(result, "geoms") or hasattr(result, "coords")  # LineString or MultiLineString


# --- tile-alignment-specific edge cases ---

def _radial_dome_dem(tmp_path, grid=40, pixel=0.005):
    transform = from_origin(-105.0, 45.0, pixel, pixel)
    y, x = np.indices((grid, grid))
    center = grid / 2
    radius = np.sqrt((x - center) ** 2 + (y - center) ** 2)
    array = (1000.0 - radius * 20.0).astype("float32")
    path = _write_dem(tmp_path / "dome_dem.tif", array, transform)
    return path


def test_tile_size_evenly_dividing_raster(tmp_path):
    # 40 / tile_size=10 -> exactly 4x4 tiles, no partial/remainder tiles.
    path = _radial_dome_dem(tmp_path, grid=40)
    merged = extract_strandline_contours_windowed(path, target_elevation=700.0, tile_size=10, halo=2)
    assert not merged.is_empty


def test_tile_size_not_evenly_dividing_raster(tmp_path):
    # 40 / tile_size=13 -> 4 tiles per axis with a small remainder tile
    # (13, 13, 13, 1) -- exercises the core_w/core_h clipping logic.
    path = _radial_dome_dem(tmp_path, grid=40)
    merged = extract_strandline_contours_windowed(path, target_elevation=700.0, tile_size=13, halo=2)
    assert not merged.is_empty


def test_single_tile_covers_entire_raster(tmp_path):
    # tile_size >= raster dimensions -> exactly one tile, no stitching needed
    # at all. Confirms the single-tile path still works, not just multi-tile.
    path = _radial_dome_dem(tmp_path, grid=40)
    merged = extract_strandline_contours_windowed(path, target_elevation=700.0, tile_size=1024, halo=32)
    assert not merged.is_empty


def test_zero_halo_can_miss_a_boundary_crossing_contour(tmp_path):
    # KNOWN LIMITATION: halo=0 means each tile is read with no padding, so a
    # contour that crosses exactly along a tile boundary can be clipped away
    # by both neighboring tiles' core_bbox intersection rather than captured
    # by either. This documents why the halo parameter exists and defaults
    # to a nonzero value -- it isn't testing a "should never happen" bug,
    # it's testing that the documented purpose of `halo` is real.
    path = _radial_dome_dem(tmp_path, grid=40)
    with_halo = extract_strandline_contours_windowed(path, target_elevation=700.0, tile_size=10, halo=4)
    without_halo = extract_strandline_contours_windowed(path, target_elevation=700.0, tile_size=10, halo=0)
    # Both should find *something*, but the padded version should capture at
    # least as much of the true contour (never less) since it has the extra
    # context needed to stitch across tile seams correctly.
    assert with_halo.length >= without_halo.length


def test_contour_crossing_tile_boundary_is_not_duplicated(tmp_path):
    # A single ring that spans multiple tiles should be stitched into a
    # single continuous piece of geometry, not doubled/counted twice by
    # both tiles that share the boundary it crosses.
    path = _radial_dome_dem(tmp_path, grid=40)
    small_tiles = extract_strandline_contours_windowed(path, target_elevation=700.0, tile_size=10, halo=4)
    one_tile = extract_strandline_contours_windowed(path, target_elevation=700.0, tile_size=1024, halo=32)
    # The multi-tile version shouldn't have MORE total length than the
    # single-tile version -- if it did, that would indicate a seam is being
    # traced/counted more than once instead of merged.
    assert small_tiles.length <= one_tile.length * 1.05  # small tolerance for interpolation differences


def test_large_halo_larger_than_tile_still_works(tmp_path):
    # An unusually large halo (bigger than the tile itself) should just get
    # clipped to the raster bounds via the existing max(..., 0)/min(..., width)
    # logic, not error out.
    path = _radial_dome_dem(tmp_path, grid=40)
    merged = extract_strandline_contours_windowed(path, target_elevation=700.0, tile_size=10, halo=100)
    assert not merged.is_empty
