"""
Tests for /api/process's zip-bundled response (see
documentation/VISUALIZATION_PIPELINE_SPEC.md Stage 3). This is the one change in the
visualization pipeline spec that touches previously-tested behavior --
/api/process used to return the .gpkg directly -- so it gets its own
dedicated coverage, flagged explicitly per the spec.

Calls api.main.process directly (in-process), same pattern as
tests/test_api_process_target_elevation.py and api/smoke_test.py.
"""
import asyncio
import io
import json
import zipfile

import geopandas as gpd
import pytest
import rasterio
from starlette.background import BackgroundTasks

from api.main import process


def _run(file_path, include_dem, target_elevation=450, tilt_factor=0.0):
    async def _call():
        background_tasks = BackgroundTasks()
        response = await process(
            background_tasks=background_tasks,
            dem_file=None,
            file_path=file_path,
            origin_mode="decimal_degrees",
            origin_value="44.945N,104.945W",
            origin_epsg=None,
            tilt_azimuth=90,
            tilt_factor=tilt_factor,
            target_elevation=target_elevation,
            include_dem=include_dem,
        )
        if response.background:
            await response.background()
        return response

    return asyncio.run(_call())


def test_zip_contains_gpkg_and_contour_when_include_dem_false(sloped_dem_path, tmp_path):
    response = _run(sloped_dem_path, include_dem=False)
    assert response.media_type == "application/zip"

    with zipfile.ZipFile(io.BytesIO(response.body)) as zf:
        names = set(zf.namelist())
        assert names == {"strandlines.gpkg", "contour.geojson"}

        contour_bytes = zf.read("contour.geojson")
        # Extract to a real file on disk (what a real client would do with
        # the downloaded bytes anyway) rather than an in-memory buffer --
        # include_dem=False means this .gpkg has only the vector
        # strandline_contour layer, no raster table, and GDAL's GPKG
        # driver needs a real path for the vector (OGR) side regardless.
        extracted_gpkg = zf.extract("strandlines.gpkg", tmp_path)

    contour = json.loads(contour_bytes)
    assert contour["type"] == "FeatureCollection"

    gdf = gpd.read_file(extracted_gpkg, layer="strandline_contour")
    assert len(gdf) == len(contour["features"])


def test_zip_includes_preview_tilted_tif_when_include_dem_true(sloped_dem_path):
    response = _run(sloped_dem_path, include_dem=True)

    with zipfile.ZipFile(io.BytesIO(response.body)) as zf:
        names = set(zf.namelist())
        assert names == {"strandlines.gpkg", "contour.geojson", "preview_tilted.tif"}
        preview_bytes = zf.read("preview_tilted.tif")

    with rasterio.MemoryFile(preview_bytes) as mem:
        with mem.open() as src:
            assert src.crs == rasterio.crs.CRS.from_epsg(4326)
            assert src.count == 1


def test_headers_unaffected_by_zip_bundling(flat_dem_path):
    # flat_dem_path is 1000.0 m everywhere; submitted target_elevation (500)
    # deliberately disagrees, exercising the same header path
    # test_api_process_target_elevation.py already covers -- just confirming
    # it survives unchanged now that the body is a zip, not a bare .gpkg.
    response = _run(flat_dem_path, include_dem=False, target_elevation=500)
    assert response.headers["X-Target-Elevation-Source"] == "dem"
    assert "1000.00 m" in response.headers["X-Target-Elevation-Note"]
    assert response.headers["Content-Disposition"] == 'attachment; filename="results.zip"'


def test_processing_warnings_header_never_contains_a_raw_newline(sloped_dem_path, monkeypatch):
    # Regression test: warnings.simplefilter("always") inside process()
    # records every warning category, not just this codebase's own
    # UserWarnings -- so a library-internal warning with an embedded
    # newline in its message (observed in practice from a rasterio/numpy
    # DeprecationWarning under a newer numpy) previously crashed the
    # response at send time with "Invalid HTTP header value", since raw
    # newlines aren't legal in an HTTP header. Invisible to the rest of
    # this suite, which calls process() in-process and never serializes
    # headers to real HTTP bytes -- only caught by driving the app over an
    # actual ASGI server. Simulated here by making process_dem itself warn
    # with an embedded newline, independent of which library happens to
    # trigger it in any given numpy/rasterio version.
    import warnings as warnings_module

    import api.main as api_main
    from backend.app import process_dem as real_process_dem

    def _fake_process_dem(*args, **kwargs):
        warnings_module.warn(
            "First line of a library warning.\nSecond line of the same warning.",
            UserWarning,
        )
        return real_process_dem(*args, **kwargs)

    monkeypatch.setattr(api_main, "process_dem", _fake_process_dem)

    response = _run(sloped_dem_path, include_dem=False)
    header_value = response.headers["X-Processing-Warnings"]
    assert "\n" not in header_value
    assert "\r" not in header_value
    assert "First line of a library warning." in header_value


def test_gpkg_entry_in_zip_is_non_empty(sloped_dem_path):
    # Sanity check that zf.write(output_path, ...) actually captured the
    # .gpkg bytes -- the existing download flow depends on this being
    # exactly what process_dem wrote, untouched.
    response = _run(sloped_dem_path, include_dem=False)
    with zipfile.ZipFile(io.BytesIO(response.body)) as zf:
        info = zf.getinfo("strandlines.gpkg")
        assert info.file_size > 0
