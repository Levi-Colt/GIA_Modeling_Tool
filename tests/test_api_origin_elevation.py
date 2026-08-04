"""
Tests for the POST /api/origin-elevation preview endpoint.

Calls api.main.origin_elevation directly (in-process, as a plain coroutine)
rather than over real HTTP -- same approach api/smoke_test.py uses for
/api/process, and avoids adding an HTTP test client dependency this repo
doesn't otherwise need.
"""
import asyncio

import pytest
from fastapi import HTTPException

from api.main import origin_elevation


def _run(file_path, origin_mode, origin_value, origin_epsg=None):
    return asyncio.run(
        origin_elevation(
            dem_file=None,
            file_path=file_path,
            origin_mode=origin_mode,
            origin_value=origin_value,
            origin_epsg=origin_epsg,
        )
    )


def test_within_bounds_returns_dem_elevation(flat_dem_path):
    # Pixel center well inside the flat 1000.0 m DEM's grid.
    result = _run(flat_dem_path, "decimal_degrees", "44.945N,104.945W")
    assert result == {"within_bounds": True, "elevation": pytest.approx(1000.0), "reason": None}


def test_outside_bounds(flat_dem_path):
    result = _run(flat_dem_path, "decimal_degrees", "10.000000N,50.000000W")
    assert result == {"within_bounds": False, "elevation": None, "reason": "outside_bounds"}


def test_nodata_cell(tmp_path, standard_transform, raster_writer):
    import numpy as np

    array = np.full((10, 10), 1000.0, dtype="float32")
    array[5, 5] = -9999.0
    path = raster_writer(tmp_path / "nodata_cell.tif", array, standard_transform, nodata=-9999.0)

    result = _run(path, "decimal_degrees", "44.945N,104.945W")
    assert result == {"within_bounds": True, "elevation": None, "reason": "nodata"}


def test_missing_file_raises_400():
    with pytest.raises(HTTPException) as exc_info:
        _run("/no/such/file.tif", "decimal_degrees", "44.945N,104.945W")
    assert exc_info.value.status_code == 400


def test_missing_both_file_inputs_raises_422():
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            origin_elevation(
                dem_file=None,
                file_path=None,
                origin_mode="decimal_degrees",
                origin_value="44.945N,104.945W",
                origin_epsg=None,
            )
        )
    assert exc_info.value.status_code == 422


def test_malformed_raster_raises_400(malformed_file_path):
    with pytest.raises(HTTPException) as exc_info:
        _run(malformed_file_path, "decimal_degrees", "44.945N,104.945W")
    assert exc_info.value.status_code == 400
