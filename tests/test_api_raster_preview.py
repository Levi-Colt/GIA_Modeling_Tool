"""
Tests for POST /api/raster-preview (see documentation/VISUALIZATION_PIPELINE_SPEC.md
Stage 2) -- a decimated, WGS84 GeoTIFF preview of the uploaded/pathed DEM,
cheap enough to fire once right after preflight succeeds.

Calls api.main.raster_preview directly (in-process), same style as the
other API-layer tests in this suite.
"""
import asyncio
import io

import numpy as np
import pytest
import rasterio
from fastapi import HTTPException
from rasterio.transform import from_origin
from starlette.background import BackgroundTasks
from starlette.datastructures import UploadFile

from api.main import raster_preview
from api.raster_preview import PREVIEW_MAX_DIM


def _run(file_path=None, dem_file=None):
    async def _call():
        background_tasks = BackgroundTasks()
        response = await raster_preview(
            background_tasks=background_tasks, dem_file=dem_file, file_path=file_path
        )
        if response.background:
            await response.background()
        return response

    return asyncio.run(_call())


def _open_preview(response):
    return rasterio.open(io.BytesIO(response.body))


def test_already_wgs84_input_is_decimated_not_reprojected(flat_dem_path):
    response = _run(file_path=flat_dem_path)
    assert response.media_type == "image/tiff"

    with _open_preview(response) as src:
        assert src.crs == rasterio.crs.CRS.from_epsg(4326)
        assert src.width <= PREVIEW_MAX_DIM
        assert src.height <= PREVIEW_MAX_DIM
        # flat_dem.tif is 10x10, well under PREVIEW_MAX_DIM -- no decimation
        # needed, so the original 10x10 shape should be preserved exactly.
        assert (src.width, src.height) == (10, 10)


def test_projected_crs_input_is_reprojected_to_wgs84(tmp_path, raster_writer):
    array = np.full((10, 10), 500.0, dtype="float32")
    transform = from_origin(500000.0, 4980000.0, 30.0, 30.0)
    path = raster_writer(tmp_path / "utm.tif", array, transform, crs="EPSG:32612", nodata=-9999.0)

    response = _run(file_path=path)
    with _open_preview(response) as src:
        assert src.crs == rasterio.crs.CRS.from_epsg(4326)
        west, south, east, north = src.bounds
        assert -180.0 <= west <= 180.0
        assert -90.0 <= south <= 90.0
        assert west < east
        assert south < north


def test_large_raster_is_decimated_to_preview_max_dim(tmp_path, raster_writer):
    big = 2 * PREVIEW_MAX_DIM
    array = np.full((big, big), 100.0, dtype="float32")
    transform = from_origin(-105.0, 45.0, 0.0001, 0.0001)
    path = raster_writer(tmp_path / "big.tif", array, transform, crs="EPSG:4326")

    response = _run(file_path=path)
    with _open_preview(response) as src:
        assert src.width <= PREVIEW_MAX_DIM
        assert src.height <= PREVIEW_MAX_DIM


def test_dem_file_upload_variant(flat_dem_path):
    with open(flat_dem_path, "rb") as f:
        upload = UploadFile(file=io.BytesIO(f.read()), filename="dem.tif")

    response = _run(dem_file=upload)
    with _open_preview(response) as src:
        assert src.crs == rasterio.crs.CRS.from_epsg(4326)


def test_missing_both_file_inputs_raises_422():
    with pytest.raises(HTTPException) as exc_info:
        _run()
    assert exc_info.value.status_code == 422


def test_missing_file_raises_400():
    with pytest.raises(HTTPException) as exc_info:
        _run(file_path="/no/such/file.tif")
    assert exc_info.value.status_code == 400


def test_malformed_raster_raises_400(malformed_file_path):
    with pytest.raises(HTTPException) as exc_info:
        _run(file_path=malformed_file_path)
    assert exc_info.value.status_code == 400
