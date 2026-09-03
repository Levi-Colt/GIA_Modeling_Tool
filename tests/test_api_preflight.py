"""
Tests for the POST /api/preflight endpoint.

This endpoint previously had no dedicated pytest coverage at all (only
api/smoke_test.py exercised /api/process). Adding baseline coverage here
alongside the new bounds_wgs84 field (see documentation/VISUALIZATION_PIPELINE_SPEC.md
Stage 1), following the same in-process direct-call pattern used by
tests/test_api_origin_elevation.py.
"""
import asyncio

import pytest
from fastapi import HTTPException
from starlette.background import BackgroundTasks

from api.main import preflight


def _run(file_path):
    return asyncio.run(
        preflight(background_tasks=BackgroundTasks(), dem_file=None, file_path=file_path)
    )


def test_valid_raster_returns_crs_and_bounds(flat_dem_path):
    result = _run(flat_dem_path)
    assert result["crs"] == "EPSG:4326"
    assert result["band_count"] == 1
    assert result["use_windowed_io"] is False

    west, south, east, north = result["bounds_wgs84"]
    # flat_dem_path: top-left (-105.0, 45.0), 10x10 grid, 0.01 deg pixels.
    assert west == pytest.approx(-105.0)
    assert north == pytest.approx(45.0)
    assert east == pytest.approx(-104.9)
    assert south == pytest.approx(44.9)

    # Corner-to-corner diagonal of a ~0.1deg x 0.1deg box at this latitude is
    # a little under 16km -- just confirming it's a small positive number in
    # the right ballpark, not pinning down an exact geodesic figure.
    assert 0 < result["diagonal_km"] < 20


def test_bounds_wgs84_reprojected_for_projected_crs(tmp_path, raster_writer):
    import numpy as np
    from rasterio.transform import from_origin

    array = np.full((10, 10), 500.0, dtype="float32")
    transform = from_origin(500000.0, 4980000.0, 30.0, 30.0)
    path = raster_writer(tmp_path / "utm.tif", array, transform, crs="EPSG:32612", nodata=-9999.0)

    result = _run(path)
    assert result["crs"] == "EPSG:32612"
    west, south, east, north = result["bounds_wgs84"]
    # Should have been reprojected into plausible WGS84 degrees, not left
    # in raw UTM meters.
    assert -180.0 <= west <= 180.0
    assert -90.0 <= south <= 90.0
    assert west < east
    assert south < north

    # A 10x10, 30m-pixel UTM raster is ~300m x 300m -- diagonal_km must have
    # gone through get_raster_diagonal_km's CRS-aware reprojection path
    # (raw UTM meters fed straight into Geod.inv would be nonsense, likely
    # hundreds of thousands of "km").
    assert 0 < result["diagonal_km"] < 1.0


def test_missing_both_file_inputs_raises_422():
    with pytest.raises(HTTPException) as exc_info:
        _run(None)
    assert exc_info.value.status_code == 422


def test_missing_file_raises_400():
    with pytest.raises(HTTPException) as exc_info:
        _run("/no/such/file.tif")
    assert exc_info.value.status_code == 400


def test_malformed_raster_raises_400(malformed_file_path):
    with pytest.raises(HTTPException) as exc_info:
        _run(malformed_file_path)
    assert exc_info.value.status_code == 400


def test_unsupported_extension_raises_422(tmp_path):
    path = tmp_path / "not_a_raster.png"
    path.write_bytes(b"not a tif")
    with pytest.raises(HTTPException) as exc_info:
        _run(str(path))
    assert exc_info.value.status_code == 422
