"""
Tests for backend.main's shared local frame (_local_en_km / _local_en_to_lonlat)
and uplift_d_range_km (documentation/UPLIFT_MODEL_SPEC.md D2 / D7).
"""
import numpy as np
import pytest
from pyproj import Geod

from backend.main import (
    RECALIBRATION_THRESHOLD_KM,
    _local_en_km,
    _local_en_to_lonlat,
    _raster_diagonal_km,
    uplift_d_range_km,
)
from backend.uplift import linear_planar_model
from rasterio.transform import from_origin

GEOD = Geod(ellps="WGS84")

# Small: ~28 km diagonal (single calibration). Large: the synthetic ~423 km
# grid from PERFORMANCE_OPTIMIZATION_SPEC.md (per-row cos(lat) correction).
CASES = {
    "small": dict(transform=from_origin(-105.0, 45.0, 0.005, 0.005), shape=(40, 40), origin=(-104.9, 44.9)),
    "large": dict(transform=from_origin(-110.0, 40.0, 0.01, 0.01), shape=(300, 300), origin=(-108.5, 38.5)),
}


def _grid(case):
    height, width = case["shape"]
    t = case["transform"]
    cols = np.arange(width)
    rows = np.arange(height)
    lons = t.a * (cols + 0.5) + t.c
    lats = t.e * (rows + 0.5) + t.f
    return lons[np.newaxis, :], lats[:, np.newaxis]


@pytest.mark.parametrize("name", sorted(CASES))
def test_round_trip_is_exact_to_1e9_degrees(name):
    case = CASES[name]
    diagonal_km = _raster_diagonal_km(case["transform"], case["shape"], geod=GEOD)
    lons, lats = _grid(case)

    east, north = _local_en_km(lons, lats, case["origin"], diagonal_km, GEOD)
    lons_back, lats_back = _local_en_to_lonlat(east, north, case["origin"], diagonal_km, GEOD)

    np.testing.assert_allclose(lons_back, np.broadcast_to(lons, lons_back.shape), rtol=0, atol=1e-9)
    np.testing.assert_allclose(lats_back, np.broadcast_to(lats, lats_back.shape), rtol=0, atol=1e-9)


def test_cases_straddle_the_recalibration_threshold():
    small = _raster_diagonal_km(CASES["small"]["transform"], CASES["small"]["shape"])
    large = _raster_diagonal_km(CASES["large"]["transform"], CASES["large"]["shape"])
    assert small < RECALIBRATION_THRESHOLD_KM < large


@pytest.mark.parametrize("diagonal_km", [10.0, 500.0])
def test_round_trip_holds_for_scalar_and_2d_inputs(diagonal_km):
    origin = (-100.0, 50.0)
    lons = np.array([[-101.0, -99.5], [-100.2, -98.0]])
    lats = np.array([[51.0, 49.0], [50.0, 52.5]])
    east, north = _local_en_km(lons, lats, origin, diagonal_km, GEOD)
    lons_back, lats_back = _local_en_to_lonlat(east, north, origin, diagonal_km, GEOD)
    np.testing.assert_allclose(lons_back, lons, rtol=0, atol=1e-9)
    np.testing.assert_allclose(lats_back, lats, rtol=0, atol=1e-9)


def test_origin_maps_to_zero_offset():
    east, north = _local_en_km(np.array([-104.9]), np.array([44.9]), (-104.9, 44.9), 20.0, GEOD)
    assert east[0] == 0.0 and north[0] == 0.0


def test_axes_point_east_and_north():
    origin = (-104.9, 44.9)
    east, north = _local_en_km(np.array([-104.8, -104.9]), np.array([44.9, 45.0]), origin, 20.0, GEOD)
    assert east[0] > 0 and north[0] == 0.0
    assert east[1] == 0.0 and north[1] > 0
    # ~0.1 deg of latitude is ~11.1 km.
    assert north[1] == pytest.approx(11.1, abs=0.1)


def test_uplift_d_range_projects_bbox_corners_onto_azimuth():
    origin = (-104.9, 44.9)
    bounds = [-105.0, 44.8, -104.8, 45.0]  # origin at the centre
    due_north = linear_planar_model(0.0, 1.0)
    d_min, d_max = uplift_d_range_km(due_north, origin, bounds)
    assert d_min == pytest.approx(-11.1, abs=0.1)
    assert d_max == pytest.approx(11.1, abs=0.1)

    due_east = linear_planar_model(90.0, 1.0)
    d_min, d_max = uplift_d_range_km(due_east, origin, bounds)
    assert d_min == pytest.approx(-d_max, rel=1e-6)
    assert d_max == pytest.approx(7.9, abs=0.2)  # 0.1 deg lon at 45N ~ 7.9 km


def test_uplift_d_range_is_ordered_for_any_azimuth():
    origin = (-104.9, 44.9)
    bounds = [-105.0, 44.8, -104.8, 45.0]
    for azimuth in (0, 28, 135, 225, 300):
        d_min, d_max = uplift_d_range_km(linear_planar_model(float(azimuth), 1.0), origin, bounds)
        assert d_min < 0 < d_max
