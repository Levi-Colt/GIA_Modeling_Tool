"""
Tests for the POST /api/resolve-point endpoint (see
documentation/VISUALIZATION_PIPELINE_SPEC.md Stage 1) -- cheap coordinate resolution, no
file I/O, used to drive the client-side azimuth-line preview on every
coordinate-field blur.

Calls api.main.resolve_point directly (in-process), same style as
tests/test_api_origin_elevation.py.
"""
import asyncio

import pytest
from fastapi import HTTPException
from pyproj import Transformer

from api.main import resolve_point, ResolvePointRequest


def _run(**kwargs):
    return asyncio.run(resolve_point(ResolvePointRequest(**kwargs)))


def test_decimal_degrees_success():
    result = _run(origin_mode="decimal_degrees", origin_value="44.945N,104.945W")
    assert result == {"lon": pytest.approx(-104.945), "lat": pytest.approx(44.945)}


def test_decimal_degrees_order_agnostic():
    result = _run(origin_mode="decimal_degrees", origin_value="104.945W,44.945N")
    assert result == {"lon": pytest.approx(-104.945), "lat": pytest.approx(44.945)}


def test_epsg_success():
    x, y = 500000.0, 4980000.0
    lon, lat = Transformer.from_crs("EPSG:32612", "EPSG:4326", always_xy=True).transform(x, y)

    result = _run(origin_mode="epsg", origin_value=f"{x},{y}", origin_epsg="EPSG:32612")
    assert result == {"lon": pytest.approx(lon), "lat": pytest.approx(lat)}


def test_match_raster_success():
    x, y = 500000.0, 4980000.0
    lon, lat = Transformer.from_crs("EPSG:32612", "EPSG:4326", always_xy=True).transform(x, y)

    result = _run(
        origin_mode="match_raster", origin_value=f"{x},{y}", native_crs="EPSG:32612"
    )
    assert result == {"lon": pytest.approx(lon), "lat": pytest.approx(lat)}


def test_match_raster_missing_native_crs_raises_422():
    with pytest.raises(HTTPException) as exc_info:
        _run(origin_mode="match_raster", origin_value="500000,4980000")
    assert exc_info.value.status_code == 422


def test_epsg_missing_origin_epsg_raises_422():
    with pytest.raises(HTTPException) as exc_info:
        _run(origin_mode="epsg", origin_value="500000,4980000")
    assert exc_info.value.status_code == 422


def test_invalid_origin_mode_raises_422():
    with pytest.raises(HTTPException) as exc_info:
        _run(origin_mode="bogus", origin_value="1,2")
    assert exc_info.value.status_code == 422


def test_malformed_decimal_degrees_raises_422():
    with pytest.raises(HTTPException) as exc_info:
        _run(origin_mode="decimal_degrees", origin_value="45.25,110.55")
    assert exc_info.value.status_code == 422


def test_malformed_xy_pair_raises_422():
    with pytest.raises(HTTPException) as exc_info:
        _run(origin_mode="epsg", origin_value="not-a-number", origin_epsg="EPSG:32612")
    assert exc_info.value.status_code == 422
