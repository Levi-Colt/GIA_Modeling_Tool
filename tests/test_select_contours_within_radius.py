"""
Tests for main.select_contours_within_radius -- the optional selection-radius
filter (documentation/SELECTION_RADIUS_SPEC.md B1). Points are placed at exact
geodesic distances from the origin with Geod.fwd, so the radius boundary tests
aren't sensitive to lon/lat degree scale.
"""
import numpy as np
import pytest
from pyproj import Geod
from shapely.geometry import LineString

from backend.main import select_contours_within_radius

GEOD = Geod(ellps="WGS84")
ORIGIN = (-104.95, 44.95)
RADIUS_KM = 10.0


def _point_at(distance_km, azimuth=90.0):
    lon, lat, _ = GEOD.fwd(ORIGIN[0], ORIGIN[1], azimuth, distance_km * 1000.0)
    return (lon, lat)


def _line_through(*distances_km, azimuth=90.0):
    return LineString([_point_at(d, azimuth) for d in distances_km])


def _dist_m(point):
    return GEOD.inv(ORIGIN[0], ORIGIN[1], point[0], point[1])[2]


# --- "intersects" mode ---

def test_line_with_one_vertex_inside_is_kept_unchanged():
    line = _line_through(50, 5, 60)
    result = select_contours_within_radius([line], ORIGIN, RADIUS_KM)
    assert len(result) == 1
    assert result[0].equals(line)


def test_line_entirely_outside_is_dropped():
    line = _line_through(30, 40, 50)
    assert select_contours_within_radius([line], ORIGIN, RADIUS_KM) == []


def test_line_fully_inside_is_kept_unchanged():
    line = _line_through(1, 3, 6)
    result = select_contours_within_radius([line], ORIGIN, RADIUS_KM)
    assert len(result) == 1
    assert result[0].equals(line)


def test_nearest_vertex_just_inside_vs_just_outside_the_radius():
    just_inside = _line_through(RADIUS_KM - 0.05, 40)
    just_outside = _line_through(RADIUS_KM + 0.05, 40)
    result = select_contours_within_radius([just_inside, just_outside], ORIGIN, RADIUS_KM)
    assert len(result) == 1
    assert result[0].equals(just_inside)


def test_keeps_only_qualifying_lines_and_preserves_order():
    near_a, far, near_b = _line_through(2, 30), _line_through(30, 40), _line_through(4, 50)
    result = select_contours_within_radius([near_a, far, near_b], ORIGIN, RADIUS_KM)
    assert [r.equals(x) for r, x in zip(result, [near_a, near_b])] == [True, True]
    assert len(result) == 2


def test_input_list_is_not_mutated():
    lines = [_line_through(2, 30), _line_through(30, 40)]
    snapshot = [line.wkt for line in lines]
    select_contours_within_radius(lines, ORIGIN, RADIUS_KM)
    select_contours_within_radius(lines, ORIGIN, RADIUS_KM, mode="clip")
    assert len(lines) == 2
    assert [line.wkt for line in lines] == snapshot


def test_empty_input_returns_empty_list():
    assert select_contours_within_radius([], ORIGIN, RADIUS_KM) == []


# --- "clip" mode ---

def test_clip_mode_shortens_a_line_crossing_the_circle():
    line = _line_through(-30, 30)  # passes straight through the origin
    result = select_contours_within_radius([line], ORIGIN, RADIUS_KM, mode="clip")
    assert len(result) == 1
    assert result[0].length < line.length
    for coord in result[0].coords:
        assert _dist_m(coord) <= RADIUS_KM * 1000.0 + 5.0


def test_clip_mode_line_crossing_circle_twice_yields_two_pieces():
    # A U-shaped path: enters the circle, leaves it, comes back in.
    line = LineString([_point_at(20, 0), _point_at(5, 0), _point_at(20, 0),
                       _point_at(20, 90), _point_at(5, 90), _point_at(20, 90)])
    result = select_contours_within_radius([line], ORIGIN, RADIUS_KM, mode="clip")
    assert len(result) == 2
    for piece in result:
        assert piece.geom_type == "LineString"
        for coord in piece.coords:
            assert _dist_m(coord) <= RADIUS_KM * 1000.0 + 5.0


def test_clip_mode_drops_lines_entirely_outside():
    assert select_contours_within_radius([_line_through(30, 40)], ORIGIN, RADIUS_KM, mode="clip") == []


def test_clip_mode_keeps_fully_inside_line_intact():
    line = _line_through(1, 3, 6)
    result = select_contours_within_radius([line], ORIGIN, RADIUS_KM, mode="clip")
    assert len(result) == 1
    assert result[0].length == pytest.approx(line.length, rel=1e-3)


# --- validation ---

@pytest.mark.parametrize("bad_radius", [0, -1, -0.5, float("nan"), float("inf"), float("-inf")])
def test_invalid_radius_raises(bad_radius):
    with pytest.raises(ValueError):
        select_contours_within_radius([_line_through(1, 2)], ORIGIN, bad_radius)


def test_unknown_mode_raises():
    with pytest.raises(ValueError):
        select_contours_within_radius([_line_through(1, 2)], ORIGIN, RADIUS_KM, mode="buffer")
