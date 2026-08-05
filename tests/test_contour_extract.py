"""
Unit tests for main.extract_strandline_contours.
"""
import numpy as np
import pytest

from backend.main import extract_strandline_contours


def test_contours_positive_elevation_gradient(sloped_dem_array, standard_transform):
    # sloped_dem_array ranges 0..900 across columns; 450 sits squarely inside.
    contours = extract_strandline_contours(sloped_dem_array, standard_transform, target_elevation=450)
    assert len(contours) >= 1


def test_contours_negative_elevation_gradient(sloped_dem_array, standard_transform):
    shifted = sloped_dem_array - 1000.0  # now ranges -1000..-100
    contours = extract_strandline_contours(shifted, standard_transform, target_elevation=-550)
    assert len(contours) >= 1


def test_flat_array_at_target_elevation_does_not_error(flat_dem_array, standard_transform):
    # Every cell equals the target exactly -- an ambiguous/degenerate case.
    # skimage may find zero real contours here, but the target is in-range
    # (min == max == target), so this must not raise.
    contours = extract_strandline_contours(flat_dem_array, standard_transform, target_elevation=1000.0)
    assert isinstance(contours, list)


def test_big_elevation_gap_still_produces_interpolated_contour(standard_transform):
    # A sharp cliff: left half at 0m, right half at 1000m. The target (500)
    # never appears as an actual cell value, but marching squares should
    # still interpolate a contour crossing the boundary.
    array = np.zeros((10, 10), dtype="float32")
    array[:, 5:] = 1000.0
    contours = extract_strandline_contours(array, standard_transform, target_elevation=500)
    assert len(contours) >= 1


def test_nan_bordered_dem_returns_only_finite_coordinates(standard_transform):
    array = np.full((10, 10), np.nan, dtype="float32")
    array[2:8, 2:8] = np.tile(np.arange(6, dtype="float32") * 100.0, (6, 1))  # interior gradient 0..500
    contours = extract_strandline_contours(array, standard_transform, target_elevation=250)
    assert len(contours) >= 1
    for contour in contours:
        assert np.all(np.isfinite(contour))


def test_all_nan_raises_value_error(standard_transform):
    array = np.full((10, 10), np.nan, dtype="float32")
    with pytest.raises(ValueError, match="no valid"):
        extract_strandline_contours(array, standard_transform, target_elevation=100)


def test_target_above_valid_range_raises_out_of_range_error(sloped_dem_array, standard_transform):
    with pytest.raises(ValueError, match="outside the DEM's valid elevation range"):
        extract_strandline_contours(sloped_dem_array, standard_transform, target_elevation=99999)


def test_target_below_valid_range_raises_out_of_range_error(sloped_dem_array, standard_transform):
    with pytest.raises(ValueError, match="outside the DEM's valid elevation range"):
        extract_strandline_contours(sloped_dem_array, standard_transform, target_elevation=-99999)


def test_target_exactly_at_min_boundary_does_not_raise(sloped_dem_array, standard_transform):
    valid_min = float(np.nanmin(sloped_dem_array))
    # Should not raise the out-of-range error; may or may not find a contour.
    extract_strandline_contours(sloped_dem_array, standard_transform, target_elevation=valid_min)


def test_target_exactly_at_max_boundary_does_not_raise(sloped_dem_array, standard_transform):
    valid_max = float(np.nanmax(sloped_dem_array))
    extract_strandline_contours(sloped_dem_array, standard_transform, target_elevation=valid_max)


def test_multiple_disjoint_contours_are_all_returned(standard_transform):
    # A radial dome: a mid-range target elevation is crossed twice by any
    # given row/column (once on each side of the peak), forming a single
    # closed ring -- but skimage represents that as one contour path, so to
    # exercise genuinely SEPARATE contour paths we use two isolated peaks.
    array = np.zeros((20, 20), dtype="float32")
    yy, xx = np.indices((20, 20))
    peak_a = 500.0 * np.exp(-(((xx - 5) ** 2 + (yy - 5) ** 2) / 8.0))
    peak_b = 500.0 * np.exp(-(((xx - 15) ** 2 + (yy - 15) ** 2) / 8.0))
    array = (peak_a + peak_b).astype("float32")

    contours = extract_strandline_contours(array, standard_transform, target_elevation=250.0)
    assert len(contours) >= 2


def test_sparse_valid_data_does_not_crash(standard_transform):
    # Almost entirely NaN, with just a handful of scattered valid pixels --
    # not enough structure to form a real contour, but should degrade
    # gracefully (empty result) rather than raising from skimage internals.
    array = np.full((10, 10), np.nan, dtype="float32")
    array[0, 0] = 100.0
    array[9, 9] = 200.0
    array[5, 5] = 150.0

    contours = extract_strandline_contours(array, standard_transform, target_elevation=150.0)
    assert isinstance(contours, list)


def test_non_square_pixels_still_produce_valid_geo_coordinates():
    # x and y pixel sizes differ -- the pixel-to-geographic transform is what
    # does the real work here, so contouring should be unaffected by non-square
    # pixels as long as the transform correctly describes them.
    from rasterio.transform import from_origin
    transform = from_origin(-105.0, 45.0, 0.02, 0.005)
    row = np.arange(10, dtype="float32") * 100.0
    array = np.tile(row, (10, 1))

    contours = extract_strandline_contours(array, transform, target_elevation=450)
    assert len(contours) >= 1
    for contour in contours:
        assert np.all(np.isfinite(contour))


def test_single_pixel_dem_out_of_range_raises_cleanly(standard_transform):
    # A 1x1 array has a single elevation value, so any other target is
    # trivially "out of range" -- confirms that error path doesn't crash on
    # a degenerate shape rather than testing contouring itself.
    array = np.array([[1000.0]], dtype="float32")
    with pytest.raises(ValueError, match="outside the DEM's valid elevation range"):
        extract_strandline_contours(array, standard_transform, target_elevation=500.0)


def test_valid_elevation_matching_nan_fill_sentinel_is_misdetected(standard_transform):
    # KNOWN LIMITATION, not a desired behavior: NaNs are internally filled
    # with -99999.0 before contouring so the marching-squares algorithm has
    # a clean array to work with, and any contour touching an originally-NaN
    # pixel gets filtered out as a NaN-boundary artifact. If a REAL,
    # non-NaN elevation value ever legitimately equals -99999 AND is
    # adjacent to genuine NaN cells, the two regions become indistinguishable
    # after filling -- they merge into one contiguous "-99999" blob. The
    # real boundary of the legitimate data gets absorbed into that blob
    # rather than traced on its own, and the blob's own outer edge (which
    # does touch real NaN cells) gets correctly filtered -- so the net
    # result is the legitimate contour vanishes entirely, with no error or
    # warning raised. This is physically implausible for real elevation
    # data in this tool's domain, so it isn't being fixed right now -- but
    # this test documents the behavior so it doesn't silently change (for
    # better or worse) if the sentinel value or fill strategy is ever
    # revisited.
    from rasterio.transform import from_origin
    transform = from_origin(-105.0, 45.0, 0.01, 0.01)

    array = np.full((12, 12), 1000.0, dtype="float32")
    array[4:8, 4:8] = np.nan        # genuine NaN ring
    array[5:7, 5:7] = -99999.0      # real legitimate center patch, coincidentally == sentinel

    contours = extract_strandline_contours(array, transform, target_elevation=-99999.0)
    assert contours == []  # the legitimate boundary is lost, not merely mis-filtered
