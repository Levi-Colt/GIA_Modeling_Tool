"""
Tests for /api/process's server-side target_elevation override: when the
origin falls on valid DEM data, the DEM's own elevation there is
authoritative and overrides whatever target_elevation the client submitted
(see TARGET_ELEVATION_AND_GPKG_TASKS.md Task 3).

Calls api.main.process directly, same in-process pattern api/smoke_test.py
and tests/test_api_origin_elevation.py use.
"""
import asyncio

from starlette.background import BackgroundTasks

from api.main import process


def _run(file_path, origin_mode, origin_value, target_elevation, origin_epsg=None):
    async def _call():
        background_tasks = BackgroundTasks()
        response = await process(
            background_tasks=background_tasks,
            dem_file=None,
            file_path=file_path,
            origin_mode=origin_mode,
            origin_value=origin_value,
            origin_epsg=origin_epsg,
            tilt_azimuth=90,
            tilt_factor=0.0,
            target_elevation=target_elevation,
            include_dem=False,
        )
        if response.background:
            await response.background()
        return response

    return asyncio.run(_call())


def test_dem_value_overrides_submitted_target_elevation(flat_dem_path):
    # flat_dem_path is 1000.0 m everywhere; submitted target_elevation (500)
    # deliberately disagrees with it.
    response = _run(flat_dem_path, "decimal_degrees", "44.945N,104.945W", target_elevation=500)

    assert response.headers["X-Target-Elevation-Source"] == "dem"
    note = response.headers["X-Target-Elevation-Note"]
    assert "1000.00 m" in note
    assert "500.00 m" in note


def test_matching_submitted_value_gets_no_note(flat_dem_path):
    # Submitted value already matches the DEM's actual elevation at the
    # origin (e.g. frontend preview pre-filled it) -- source is still "dem",
    # but no note is needed since there's nothing to explain.
    response = _run(flat_dem_path, "decimal_degrees", "44.945N,104.945W", target_elevation=1000.0)

    assert response.headers["X-Target-Elevation-Source"] == "dem"
    assert "X-Target-Elevation-Note" not in response.headers


def test_manual_value_used_when_origin_outside_dem(sloped_dem_path):
    # sloped_dem_path spans lon [-105.0, -104.9], lat [44.9, 45.0]; this
    # origin is ~136m past the SE corner -- within the 500m plausibility
    # threshold but genuinely outside the raster's own grid, so there's
    # nothing to sample.
    response = _run(sloped_dem_path, "decimal_degrees", "44.899000N,104.899000W", target_elevation=450)

    assert response.headers["X-Target-Elevation-Source"] == "manual"
    assert "X-Target-Elevation-Note" not in response.headers
