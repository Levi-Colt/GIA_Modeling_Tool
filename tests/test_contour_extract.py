"""
Unit tests for main.extract_strandline_contours.
"""
import numpy as np
import pytest

from main import extract_strandline_contours


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
