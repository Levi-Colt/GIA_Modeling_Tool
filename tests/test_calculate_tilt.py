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

from main import calculate_tilt

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
