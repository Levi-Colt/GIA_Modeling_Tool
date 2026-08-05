"""
Unit tests for main.load_DEM.
"""
import numpy as np
import pytest
import rasterio

from backend.main import load_DEM, raster_io_check


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


def test_all_nodata_dem_loads_as_entirely_nan(tmp_path, standard_transform, raster_writer):
    array = np.full((10, 10), -9999.0, dtype="float32")
    path = raster_writer(tmp_path / "all_nodata.tif", array, standard_transform, nodata=-9999.0)

    needs_casting, band_count = _io_flags(path)
    result, _, _ = load_DEM(path, needs_casting, band_count)
    assert np.all(np.isnan(result))


def test_no_truncation_warning_for_same_itemsize_dtype(tmp_path, standard_transform, raster_writer):
    # int32 is 4 bytes, same as float32, so today's itemsize-based truncation
    # check stays silent here -- even though casting a large int32 value to
    # float32 can still lose precision (float32 only has a 24-bit integer
    # mantissa). This test documents the current behavior; if that heuristic
    # is ever tightened to compare int vs float precision more carefully,
    # this test should be revisited rather than just deleted.
    array = np.full((10, 10), 123456789, dtype="int32")
    path = raster_writer(tmp_path / "int32_dem.tif", array, standard_transform, dtype="int32", nodata=-9999)

    needs_casting, band_count = _io_flags(path)
    assert needs_casting is True  # dtype string differs from 'float32'
    with warnings_none_of_type("precision than float32"):
        load_DEM(path, needs_casting, band_count)


def test_truncation_and_nodata_warnings_both_fire_together(tmp_path, standard_transform, raster_writer):
    # float64 (triggers truncation warning) with no nodata value defined
    # (triggers nodata warning) -- both should fire in the same call, not
    # just whichever is checked first. Nested pytest.warns() blocks interact
    # awkwardly with each other's filter state, so this captures everything
    # in one pass instead.
    import warnings as _warnings

    array = np.full((10, 10), 1000.0, dtype="float64")
    path = raster_writer(tmp_path / "float64_no_nodata.tif", array, standard_transform, dtype="float64", nodata=None)

    needs_casting, band_count = _io_flags(path)
    with _warnings.catch_warnings(record=True) as caught:
        _warnings.simplefilter("always")
        load_DEM(path, needs_casting, band_count)

    messages = [str(w.message) for w in caught]
    assert any("precision than float32" in m for m in messages)
    assert any("nodata" in m for m in messages)


def test_trusts_passed_band_count_over_actual_file_band_count(multiband_dem_path):
    # load_DEM's band-count warning is driven entirely by the band_count
    # parameter it's handed, not by re-reading the file itself. This documents
    # that coupling: if a caller (e.g. raster_io_check) ever got out of sync
    # with the actual file, load_DEM would trust the stale value rather than
    # catching the mismatch itself.
    needs_casting, _ = _io_flags(multiband_dem_path)
    with warnings_none_of_type("bands"):
        load_DEM(multiband_dem_path, needs_casting, band_count=1)


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
