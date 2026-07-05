"""
Unit tests for main.load_DEM.
"""
import numpy as np
import pytest
import rasterio

from main import load_DEM, raster_io_check


def _io_flags(path):
    """Small helper: derive needs_casting/band_count the way app.py would."""
    strategy = raster_io_check(path, available_ram_mb=1_000_000)
    return strategy["needs_casting"], strategy["band_count"]


def test_successfully_loads_good_raster(flat_dem_path):
    needs_casting, band_count = _io_flags(flat_dem_path)
    array, transform, crs = load_DEM(flat_dem_path, needs_casting, band_count)
    assert array.shape == (10, 10)


def test_returns_array_transform_and_crs(flat_dem_path):
    needs_casting, band_count = _io_flags(flat_dem_path)
    array, transform, crs = load_DEM(flat_dem_path, needs_casting, band_count)
    assert isinstance(array, np.ndarray)
    assert isinstance(transform, rasterio.Affine)
    assert crs is not None


def test_warns_when_band_count_greater_than_one(multiband_dem_path):
    needs_casting, band_count = _io_flags(multiband_dem_path)
    with pytest.warns(UserWarning, match="bands"):
        load_DEM(multiband_dem_path, needs_casting, band_count)


def test_no_band_warning_for_single_band(flat_dem_path):
    needs_casting, band_count = _io_flags(flat_dem_path)
    with warnings_none_of_type("bands"):
        load_DEM(flat_dem_path, needs_casting, band_count)


def test_casting_performed_when_needed(int16_dem_path):
    needs_casting, band_count = _io_flags(int16_dem_path)
    assert needs_casting is True
    array, _, _ = load_DEM(int16_dem_path, needs_casting, band_count)
    assert array.dtype == np.float32


def test_copy_false_path_when_no_casting_needed(flat_dem_path, flat_dem_array):
    needs_casting, band_count = _io_flags(flat_dem_path)
    assert needs_casting is False
    array, _, _ = load_DEM(flat_dem_path, needs_casting, band_count)
    # Functional check: values should exactly match the source (already float32),
    # since no casting/re-typing should have altered anything.
    assert array.dtype == np.float32
    np.testing.assert_array_equal(array, flat_dem_array)


def test_truncation_warning_for_higher_precision_dtype(float64_dem_path):
    needs_casting, band_count = _io_flags(float64_dem_path)
    assert needs_casting is True
    with pytest.warns(UserWarning, match="precision than float32"):
        load_DEM(float64_dem_path, needs_casting, band_count)


def test_no_truncation_warning_for_lower_precision_dtype(int16_dem_path):
    # int16 (2 bytes) casting up to float32 (4 bytes) loses nothing, so no
    # truncation warning should fire -- only band/nodata warnings, if any.
    needs_casting, band_count = _io_flags(int16_dem_path)
    with warnings_none_of_type("precision than float32"):
        load_DEM(int16_dem_path, needs_casting, band_count)


def test_nodata_warning_when_nodata_undefined(no_nodata_dem_path):
    needs_casting, band_count = _io_flags(no_nodata_dem_path)
    with pytest.warns(UserWarning, match="nodata"):
        load_DEM(no_nodata_dem_path, needs_casting, band_count)


def test_no_nodata_warning_when_nodata_defined(flat_dem_path):
    needs_casting, band_count = _io_flags(flat_dem_path)
    with warnings_none_of_type("nodata"):
        load_DEM(flat_dem_path, needs_casting, band_count)


def test_nodata_values_assigned_nan(tmp_path, standard_transform, raster_writer):
    array = np.full((10, 10), 1000.0, dtype="float32")
    array[0, 0] = -9999.0  # sentinel nodata pixel
    path = raster_writer(tmp_path / "with_nodata_pixel.tif", array, standard_transform, nodata=-9999.0)

    needs_casting, band_count = _io_flags(path)
    result, _, _ = load_DEM(path, needs_casting, band_count)
    assert np.isnan(result[0, 0])
    assert result[1, 1] == pytest.approx(1000.0)


# --- small local helper (not a fixture; used only within this module) ---
import contextlib
import warnings as _warnings


@contextlib.contextmanager
def warnings_none_of_type(match_substring):
    """Asserts no UserWarning containing `match_substring` was raised."""
    with _warnings.catch_warnings(record=True) as caught:
        _warnings.simplefilter("always")
        yield
    matches = [w for w in caught if match_substring in str(w.message)]
    assert not matches, f"Unexpected warning(s) containing {match_substring!r}: {matches}"
