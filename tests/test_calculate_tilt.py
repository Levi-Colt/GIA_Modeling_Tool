"""
Unit tests for main.calculate_tilt.

Grid geometry reminder (see conftest.standard_transform):
  - 10x10 grid, 0.01 degree pixels
  - top-left corner at (lon=-105.0, lat=45.0)
  - lon increases eastward (rightward), lat decreases southward (downward)
  - so the raster's bounding box is lon in [-105.0, -104.9], lat in [44.9, 45.0]
"""
import numpy as np
import pytest

from backend.main import calculate_tilt

CENTER = (-104.95, 44.95)  # roughly the middle of the 10x10 test grid
OUTSIDE = (-200.0, 45.0)   # far outside the raster's extent
TOP_LEFT_CORNER = (-105.0, 45.0)  # exactly on the raster's edge
FAR_CORNER_AZIMUTH_AWAY = (-104.9, 44.9)  # bottom-right corner


def test_modifies_cells_in_front_reduces_elevation(flat_dem_array, standard_transform):
    # Tilting east from the center: cells to the far east (in front) should
    # end up lower than they started.
    tilted = calculate_tilt(flat_dem_array, standard_transform, CENTER, tilt_azimuth=90, tilt_factor=5.0)
    assert tilted[:, -1].mean() < flat_dem_array[:, -1].mean()


def test_does_not_modify_cells_behind_origin(flat_dem_array, standard_transform):
    # Tilting east from the center: cells to the far west (behind the plane)
    # should be completely unchanged.
    tilted = calculate_tilt(flat_dem_array, standard_transform, CENTER, tilt_azimuth=90, tilt_factor=5.0)
    np.testing.assert_allclose(tilted[:, 0], flat_dem_array[:, 0])


def test_negative_azimuth_flips_which_side_is_affected(flat_dem_array, standard_transform):
    # -90 degrees == 270 degrees == due west. Now the west side should be
    # reduced and the east side left untouched -- the mirror image of the
    # tilt_azimuth=90 case above.
    tilted = calculate_tilt(flat_dem_array, standard_transform, CENTER, tilt_azimuth=-90, tilt_factor=5.0)
    assert tilted[:, 0].mean() < flat_dem_array[:, 0].mean()
    np.testing.assert_allclose(tilted[:, -1], flat_dem_array[:, -1])


def test_larger_tilt_factor_produces_larger_change(flat_dem_array, standard_transform):
    small = calculate_tilt(flat_dem_array, standard_transform, CENTER, tilt_azimuth=90, tilt_factor=1.0)
    large = calculate_tilt(flat_dem_array, standard_transform, CENTER, tilt_azimuth=90, tilt_factor=10.0)
    small_delta = (flat_dem_array - small)[:, -1].mean()
    large_delta = (flat_dem_array - large)[:, -1].mean()
    assert large_delta > small_delta


def test_azimuth_pointing_entirely_away_leaves_raster_unchanged(flat_dem_array, standard_transform):
    # Origin at the bottom-right corner, tilt pointing further away (southeast,
    # off the raster entirely) -- every cell in the grid is "behind" the tilt
    # plane, so nothing should change.
    tilted = calculate_tilt(
        flat_dem_array, standard_transform, FAR_CORNER_AZIMUTH_AWAY,
        tilt_azimuth=135, tilt_factor=5.0,
    )
    np.testing.assert_allclose(tilted, flat_dem_array)


def test_origin_on_raster_edge_does_not_warn(flat_dem_array, standard_transform):
    # A corner exactly on the boundary should count as "within" the raster.
    import warnings
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        calculate_tilt(flat_dem_array, standard_transform, TOP_LEFT_CORNER, tilt_azimuth=90, tilt_factor=1.0)
    disconnected = [w for w in caught if "outside the raster's extent" in str(w.message)]
    assert not disconnected


def test_origin_outside_raster_warns_disconnected(flat_dem_array, standard_transform):
    with pytest.warns(UserWarning, match="outside the raster's extent"):
        calculate_tilt(flat_dem_array, standard_transform, OUTSIDE, tilt_azimuth=90, tilt_factor=1.0)


def test_origin_outside_raster_still_computes_without_error(flat_dem_array, standard_transform):
    # A disconnected origin is a warning, not a fatal error -- the tilt should
    # still be computed and returned.
    with pytest.warns(UserWarning):
        tilted = calculate_tilt(flat_dem_array, standard_transform, OUTSIDE, tilt_azimuth=90, tilt_factor=1.0)
    assert tilted.shape == flat_dem_array.shape


def test_warn_if_disconnected_false_suppresses_warning(flat_dem_array, standard_transform):
    # Used internally by tilt_DEM_windowed, which performs this check once
    # upfront rather than per-block.
    import warnings
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        calculate_tilt(
            flat_dem_array, standard_transform, OUTSIDE, tilt_azimuth=90, tilt_factor=1.0,
            warn_if_disconnected=False,
        )
    disconnected = [w for w in caught if "outside the raster's extent" in str(w.message)]
    assert not disconnected


def test_zero_tilt_factor_leaves_array_unchanged(flat_dem_array, standard_transform):
    tilted = calculate_tilt(flat_dem_array, standard_transform, CENTER, tilt_azimuth=90, tilt_factor=0.0)
    np.testing.assert_allclose(tilted, flat_dem_array)


def test_negative_tilt_factor_raises_elevation_instead_of_lowering(flat_dem_array, standard_transform):
    # A negative tilt factor should flip the sign of the effect: cells in
    # front of the tilt plane should end up HIGHER than they started, not lower.
    tilted = calculate_tilt(flat_dem_array, standard_transform, CENTER, tilt_azimuth=90, tilt_factor=-5.0)
    assert tilted[:, -1].mean() > flat_dem_array[:, -1].mean()
    # Cells behind the plane are still unaffected regardless of sign.
    np.testing.assert_allclose(tilted[:, 0], flat_dem_array[:, 0])


def test_azimuth_beyond_360_degrees_behaves_like_its_equivalent(flat_dem_array, standard_transform):
    # 450 degrees and 90 degrees point the same direction (both due east);
    # the function relies on cos()'s natural periodicity rather than any
    # explicit modulo, so this should produce an identical result.
    tilted_90 = calculate_tilt(flat_dem_array, standard_transform, CENTER, tilt_azimuth=90, tilt_factor=5.0)
    tilted_450 = calculate_tilt(flat_dem_array, standard_transform, CENTER, tilt_azimuth=450, tilt_factor=5.0)
    np.testing.assert_allclose(tilted_450, tilted_90)


def test_azimuth_beyond_negative_360_degrees_behaves_like_its_equivalent(flat_dem_array, standard_transform):
    tilted_neg90 = calculate_tilt(flat_dem_array, standard_transform, CENTER, tilt_azimuth=-90, tilt_factor=5.0)
    tilted_neg450 = calculate_tilt(flat_dem_array, standard_transform, CENTER, tilt_azimuth=-450, tilt_factor=5.0)
    np.testing.assert_allclose(tilted_neg450, tilted_neg90)


def test_preexisting_nan_propagates_through_tilt(standard_transform):
    array = np.full((10, 10), 1000.0, dtype="float32")
    array[3, 3] = np.nan
    tilted = calculate_tilt(array, standard_transform, CENTER, tilt_azimuth=90, tilt_factor=5.0)
    assert np.isnan(tilted[3, 3])
    # And it shouldn't have "leaked" NaN into any other, unrelated cell.
    assert np.isnan(tilted).sum() == 1


def test_non_square_pixels_still_compute_correctly():
    # x and y pixel sizes differ (0.02 deg vs 0.005 deg) -- a real scenario
    # for some DEM sources. The tilt math derives real-world coordinates from
    # the transform itself, so it should be unaffected by non-square pixels.
    from rasterio.transform import from_origin
    transform = from_origin(-105.0, 45.0, 0.02, 0.005)
    array = np.full((10, 10), 1000.0, dtype="float32")
    center = (-104.9, 44.975)

    tilted = calculate_tilt(array, transform, center, tilt_azimuth=90, tilt_factor=5.0)
    assert tilted[:, -1].mean() < array[:, -1].mean()
    np.testing.assert_allclose(tilted[:, 0], array[:, 0])


def test_single_pixel_dem_does_not_crash(standard_transform):
    array = np.array([[1000.0]], dtype="float32")
    tilted = calculate_tilt(array, standard_transform, CENTER, tilt_azimuth=90, tilt_factor=5.0)
    assert tilted.shape == (1, 1)


def test_origin_at_a_pole_does_not_crash(flat_dem_array, standard_transform):
    # pyproj.Geod should handle this gracefully even though it's nowhere near
    # this test grid (and will correctly warn about being disconnected).
    with pytest.warns(UserWarning, match="outside the raster's extent"):
        tilted = calculate_tilt(flat_dem_array, standard_transform, (0.0, 90.0), tilt_azimuth=90, tilt_factor=5.0)
    assert tilted.shape == flat_dem_array.shape
    assert np.all(np.isfinite(tilted))


def test_origin_at_antimeridian_does_not_crash(flat_dem_array, standard_transform):
    with pytest.warns(UserWarning, match="outside the raster's extent"):
        tilted = calculate_tilt(flat_dem_array, standard_transform, (180.0, 45.0), tilt_azimuth=90, tilt_factor=5.0)
    assert tilted.shape == flat_dem_array.shape
    assert np.all(np.isfinite(tilted))
