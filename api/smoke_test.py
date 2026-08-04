"""
Smoke test for the /process endpoint's origin-mode handling.

Calls api.main.process directly (in-process, as a plain coroutine) rather
than over real HTTP, so this has no extra runtime dependency beyond what
requirements-api.txt already installs -- no test client, no live server.

Run with:
    python api/smoke_test.py
from the repository root.
"""
import asyncio
import io
import os
import sys

import numpy as np
import rasterio
from rasterio.transform import from_origin
from starlette.datastructures import UploadFile
from starlette.background import BackgroundTasks
from fastapi import HTTPException
from pyproj import Transformer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/..")

from api.main import process  # noqa: E402


# --- A small sloped DEM in a projected CRS (UTM 12N), so match_raster and
# epsg modes both exercise real reprojection, not just a WGS84 passthrough.
# Column values step 0..900 by 100, matching the pattern used by the app-level
# test suite (tests/test_process_dem.py) -- target_elevation=450 is known to
# fall inside that range, so contour extraction always succeeds. ---
NATIVE_CRS = "EPSG:32612"  # WGS84 / UTM zone 12N
GRID = 10
PIXEL_METERS = 30.0
TOP_LEFT_X = 500000.0
TOP_LEFT_Y = 4980000.0
CENTER_X = TOP_LEFT_X + PIXEL_METERS * GRID / 2
CENTER_Y = TOP_LEFT_Y - PIXEL_METERS * GRID / 2

_to_wgs84 = Transformer.from_crs(NATIVE_CRS, "EPSG:4326", always_xy=True)
CENTER_LON, CENTER_LAT = _to_wgs84.transform(CENTER_X, CENTER_Y)

_to_nad83_utm = Transformer.from_crs("EPSG:4326", "EPSG:26912", always_xy=True)
CENTER_X_NAD83, CENTER_Y_NAD83 = _to_nad83_utm.transform(CENTER_LON, CENTER_LAT)


def _build_dem_bytes() -> bytes:
    row = np.arange(GRID, dtype="float32") * 100.0
    array = np.tile(row, (GRID, 1))
    transform = from_origin(TOP_LEFT_X, TOP_LEFT_Y, PIXEL_METERS, PIXEL_METERS)
    profile = {
        "driver": "GTiff", "height": GRID, "width": GRID, "count": 1,
        "dtype": "float32", "crs": NATIVE_CRS, "transform": transform, "nodata": -9999.0,
    }
    buf = io.BytesIO()
    with rasterio.io.MemoryFile() as mem:
        with mem.open(**profile) as dst:
            dst.write(array, 1)
        buf.write(mem.read())
    return buf.getvalue()


DEM_BYTES = _build_dem_bytes()

COMMON_KWARGS = dict(tilt_azimuth=90, tilt_factor=0.0, target_elevation=450, include_dem=True)


async def _run(origin_mode, origin_value, origin_epsg=None):
    """Invokes the /process route function directly, returns (status_code, detail_or_None)."""
    upload = UploadFile(file=io.BytesIO(DEM_BYTES), filename="dem.tif")
    background_tasks = BackgroundTasks()
    try:
        response = await process(
            background_tasks=background_tasks,
            dem_file=upload,
            file_path=None,
            origin_mode=origin_mode,
            origin_value=origin_value,
            origin_epsg=origin_epsg,
            **COMMON_KWARGS,
        )
        if response.background:
            await response.background()
        return response.status_code, None
    except HTTPException as e:
        if background_tasks.tasks:
            await background_tasks()
        return e.status_code, e.detail


def _hemisphere_value(lon, lat):
    lat_hemi = "N" if lat >= 0 else "S"
    lon_hemi = "E" if lon >= 0 else "W"
    return f"{abs(lat):.6f}{lat_hemi},{abs(lon):.6f}{lon_hemi}"


async def main():
    cases = [
        (
            "match_raster success",
            dict(origin_mode="match_raster", origin_value=f"{CENTER_X},{CENTER_Y}"),
            200,
        ),
        (
            "decimal_degrees success",
            dict(origin_mode="decimal_degrees", origin_value=_hemisphere_value(CENTER_LON, CENTER_LAT)),
            200,
        ),
        (
            "epsg success",
            dict(
                origin_mode="epsg",
                origin_value=f"{CENTER_X_NAD83},{CENTER_Y_NAD83}",
                origin_epsg="EPSG:26912",
            ),
            200,
        ),
        (
            "decimal_degrees >500m from raster rejected",
            dict(
                origin_mode="decimal_degrees",
                origin_value=_hemisphere_value(CENTER_LON, CENTER_LAT + 0.02),
            ),
            422,
        ),
        (
            "malformed decimal_degrees (missing hemisphere letter) rejected",
            dict(origin_mode="decimal_degrees", origin_value="45.250000,110.550000W"),
            422,
        ),
    ]

    failures = []
    for name, kwargs, expected_status in cases:
        status, detail = await _run(**kwargs)
        ok = status == expected_status
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: expected {expected_status}, got {status}"
              + (f" ({detail})" if detail else ""))
        if not ok:
            failures.append(name)

    print()
    if failures:
        print(f"{len(failures)}/{len(cases)} case(s) failed: {failures}")
        sys.exit(1)
    print(f"All {len(cases)} cases passed.")


if __name__ == "__main__":
    asyncio.run(main())
