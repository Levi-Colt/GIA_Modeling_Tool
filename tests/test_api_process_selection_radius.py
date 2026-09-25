"""
Tests for /api/process's optional selection_radius_km (see
documentation/SELECTION_RADIUS_SPEC.md B2): validation, the
X-Selection-Summary header, and the empty-selection path.

Calls api.main.process directly (in-process), same pattern as
tests/test_api_process_response_bundle.py.
"""
import asyncio
import io
import json
import zipfile

import pytest
from fastapi import HTTPException
from starlette.background import BackgroundTasks

from api.main import process

# conftest's sloped DEM has one north-south strandline at target 450, near
# lon -104.955. This origin sits ~55 m north of the DEM's top edge (allowed:
# within the 500 m plausibility threshold), so the elevation override doesn't
# apply -- the entered target is used -- and the nearest contour vertex is
# ~600 m away, letting a tiny radius genuinely miss it.
ORIGIN_VALUE = "45.0005N,104.955W"


def _run(file_path, selection_radius_km):
    async def _call():
        background_tasks = BackgroundTasks()
        response = await process(
            background_tasks=background_tasks,
            dem_file=None,
            file_path=file_path,
            origin_mode="decimal_degrees",
            origin_value=ORIGIN_VALUE,
            origin_epsg=None,
            tilt_azimuth=90,
            tilt_factor=0.0,
            target_elevation=450,
            include_dem=False,
            selection_radius_km=selection_radius_km,
        )
        if response.background:
            await response.background()
        return response

    return asyncio.run(_call())


def _contour_features(response):
    with zipfile.ZipFile(io.BytesIO(response.body)) as zf:
        return json.loads(zf.read("contour.geojson"))["features"]


@pytest.mark.parametrize("bad_radius", [0, -5, float("nan"), float("inf")])
def test_non_positive_or_non_finite_radius_returns_422(sloped_dem_path, bad_radius):
    with pytest.raises(HTTPException) as exc_info:
        _run(sloped_dem_path, bad_radius)
    assert exc_info.value.status_code == 422
    assert "selection_radius_km" in exc_info.value.detail


def test_valid_radius_returns_summary_header_and_keeps_contour(sloped_dem_path):
    response = _run(sloped_dem_path, 50)

    assert response.status_code == 200
    summary = response.headers["X-Selection-Summary"]
    assert "50 km" in summary
    features = _contour_features(response)
    assert len(features) >= 1
    assert summary.startswith(f"{len(features)} strandline contour(s) kept")


def test_no_radius_means_no_summary_header(sloped_dem_path):
    response = _run(sloped_dem_path, None)

    assert response.status_code == 200
    assert "X-Selection-Summary" not in response.headers
    assert len(_contour_features(response)) >= 1


def test_empty_selection_still_succeeds_with_warning_and_empty_contour(sloped_dem_path):
    response = _run(sloped_dem_path, 0.1)

    assert response.status_code == 200
    assert "Try a larger selection radius" in response.headers["X-Processing-Warnings"]
    assert response.headers["X-Selection-Summary"].startswith("0 strandline contour(s) kept")
    assert _contour_features(response) == []
