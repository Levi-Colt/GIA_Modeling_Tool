"""
Tests for api.crs.sample_elevation_at_point.
"""
import numpy as np
import pytest

from api.crs import sample_elevation_at_point


def test_inside_bounds_returns_dem_value(flat_dem_path):
    # Pixel centers run from -104.995 (col 0) to -104.905 (col 9) in 0.01-deg
    # steps; -104.945 lands in the middle of the grid, well clear of edges.
    value = sample_elevation_at_point(flat_dem_path, lon=-104.945, lat=44.945)
    assert value == pytest.approx(1000.0)


def test_inside_bounds_nodata_returns_none(tmp_path, standard_transform, raster_writer):
    array = np.full((10, 10), 1000.0, dtype="float32")
    array[5, 5] = -9999.0
    path = raster_writer(tmp_path / "nodata_cell.tif", array, standard_transform, nodata=-9999.0)

    # Row 5, col 5 center.
    value = sample_elevation_at_point(path, lon=-104.945, lat=44.945)
    assert value is None


def test_inside_bounds_nan_returns_none(tmp_path, standard_transform, raster_writer):
    array = np.full((10, 10), 1000.0, dtype="float32")
    array[5, 5] = np.nan
    path = raster_writer(tmp_path / "nan_cell.tif", array, standard_transform, nodata=-9999.0)

    value = sample_elevation_at_point(path, lon=-104.945, lat=44.945)
    assert value is None


def test_outside_bounds_returns_none(flat_dem_path):
    # Raster spans lon [-105.0, -104.9], lat [44.9, 45.0]; well outside both.
    value = sample_elevation_at_point(flat_dem_path, lon=-90.0, lat=45.0)
    assert value is None


def test_sloped_dem_samples_correct_column(sloped_dem_path):
    # sloped_dem_array increases 0..900 by 100 per column; column 0 center.
    value = sample_elevation_at_point(sloped_dem_path, lon=-104.995, lat=44.945)
    assert value == pytest.approx(0.0)

    # Column 9 center.
    value = sample_elevation_at_point(sloped_dem_path, lon=-104.905, lat=44.945)
    assert value == pytest.approx(900.0)
