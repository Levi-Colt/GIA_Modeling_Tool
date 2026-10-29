"""
Tests for the POST /api/resolve-point endpoint (see
documentation/VISUALIZATION_PIPELINE_SPEC.md Stage 1) -- cheap coordinate resolution, no
file I/O, used to drive the client-side azimuth-line preview on every
coordinate-field blur. Origin input is hemisphere-annotated decimal degrees only.

Calls api.main.resolve_point directly (in-process), same style as
tests/test_api_origin_elevation.py.
"""
import asyncio

import pytest
from fastapi import HTTPException

from api.main import resolve_point, ResolvePointRequest


def _run(**kwargs):
    return asyncio.run(resolve_point(ResolvePointRequest(**kwargs)))


def test_decimal_degrees_success():
    result = _run(origin_value="44.945N,104.945W")
    assert result == {"lon": pytest.approx(-104.945), "lat": pytest.approx(44.945)}


def test_decimal_degrees_order_agnostic():
    result = _run(origin_value="104.945W,44.945N")
    assert result == {"lon": pytest.approx(-104.945), "lat": pytest.approx(44.945)}


def test_southern_and_eastern_hemispheres_are_negative_lat_positive_lon():
    result = _run(origin_value="12.5S, 34.25E")
    assert result == {"lon": pytest.approx(34.25), "lat": pytest.approx(-12.5)}


def test_malformed_decimal_degrees_raises_422():
    with pytest.raises(HTTPException) as exc_info:
        _run(origin_value="45.25,110.55")
    assert exc_info.value.status_code == 422


def test_xy_pair_in_a_projected_crs_is_no_longer_accepted():
    # The match_raster / epsg origin modes were removed: a bare "x,y" has no
    # hemisphere letters, so it is rejected like any other malformed value.
    with pytest.raises(HTTPException) as exc_info:
        _run(origin_value="500000,4980000")
    assert exc_info.value.status_code == 422


def test_out_of_range_latitude_raises_422():
    with pytest.raises(HTTPException) as exc_info:
        _run(origin_value="95N, 10E")
    assert exc_info.value.status_code == 422


def test_the_request_no_longer_has_origin_mode_or_crs_fields():
    assert set(ResolvePointRequest.model_fields) == {"origin_value"}
