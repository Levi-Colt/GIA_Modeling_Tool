"""
API layer for the GIA Modeling Tool.

One endpoint, POST /process, wraps app.process_dem with:
  - multipart file upload for the DEM
  - three explicit, unambiguous origin input modes (origin_mode /
    origin_value / origin_epsg -- see api/crs.py and api/README.md),
    normalized to EPSG:4326, plus a geodesic plausibility check against
    the raster's own extent that applies underneath all three
  - automatic reprojection of non-geographic input rasters to EPSG:4326,
    which calculate_tilt's geodetic math requires (see api/crs.py)
  - job-scoped temp storage that's cleaned up after the response is sent
  - the blocking backend call run in a threadpool, so one large/slow DEM
    doesn't stall the event loop for other concurrent requests

Run locally with:
    uvicorn api.main:app --reload
from the repository root.
"""
import os
import sys
import warnings

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

# Make the repo root (where app.py / main.py live) importable regardless of
# where uvicorn is launched from.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import process_dem  # noqa: E402  (import after sys.path fixup, see above)

from api.crs import (  # noqa: E402
    normalize_origin_to_wgs84,
    ensure_wgs84_raster,
    parse_xy_pair,
    parse_decimal_degrees_hemisphere,
    get_raster_crs,
    get_raster_bounds_wgs84,
    check_origin_within_threshold,
    InvalidCRSError,
    InvalidOriginError,
)
from api.storage import create_job_workspace, cleanup_job_workspace  # noqa: E402

app = FastAPI(title="GIA Modeling Tool API")

ALLOWED_EXTENSIONS = {".tif", ".tiff"}
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024  # 2 GB; adjust to your real ceiling

ORIGIN_MODES = {"match_raster", "decimal_degrees", "epsg"}
ORIGIN_THRESHOLD_METERS = 500.0


@app.post("/process")
async def process(
    background_tasks: BackgroundTasks,
    dem_file: UploadFile = File(..., description="Input DEM as a GeoTIFF (.tif/.tiff)"),
    origin_mode: str = Form(
        ...,
        description="How origin_value is interpreted: 'match_raster', 'decimal_degrees', or 'epsg'",
    ),
    origin_value: str = Form(
        ...,
        description=(
            "Tilt origin coordinates, format depends on origin_mode: "
            "'x,y' (floats, raster's own native CRS) for 'match_raster'; "
            "'45.25N,110.55W' (hemisphere-annotated, order-agnostic) for 'decimal_degrees'; "
            "'x,y' (floats, in origin_epsg's units) for 'epsg'."
        ),
    ),
    origin_epsg: str | None = Form(
        None,
        description="CRS of origin_value, e.g. 'EPSG:32612'. Required (and only used) when origin_mode == 'epsg'.",
    ),
    tilt_azimuth: float = Form(..., description="Tilt direction, degrees"),
    tilt_factor: float = Form(..., description="Meters of elevation change per km"),
    target_elevation: float = Form(..., description="Paleo-elevation to contour, meters"),
    include_dem: bool = Form(
        True, description="Also embed the tilted DEM as a raster layer in the output"
    ),
):
    # --- Validate the upload and the origin shape up front, before touching disk ---
    filename = dem_file.filename or ""
    ext = os.path.splitext(filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=422,
            detail=f"Unsupported file type '{ext}'. Expected one of {sorted(ALLOWED_EXTENSIONS)}.",
        )

    if origin_mode not in ORIGIN_MODES:
        raise HTTPException(
            status_code=422,
            detail=f"origin_mode must be one of {sorted(ORIGIN_MODES)}, got '{origin_mode}'.",
        )
    if origin_mode == "epsg" and not origin_epsg:
        raise HTTPException(
            status_code=422,
            detail="origin_epsg is required when origin_mode is 'epsg'.",
        )

    # --- Resolve whatever origin modes don't depend on the raster itself, up
    # front, so malformed input fails fast before any upload happens.
    # 'match_raster' needs the raster's own CRS and is resolved further down,
    # once the file is on disk. ---
    origin_lon = origin_lat = None
    try:
        if origin_mode == "decimal_degrees":
            origin_lon, origin_lat = parse_decimal_degrees_hemisphere(origin_value)
        elif origin_mode == "epsg":
            x, y = parse_xy_pair(origin_value)
            origin_lon, origin_lat = normalize_origin_to_wgs84(x, y, origin_epsg)
    except (InvalidCRSError, InvalidOriginError) as e:
        raise HTTPException(status_code=422, detail=str(e))

    job_dir = create_job_workspace()
    background_tasks.add_task(cleanup_job_workspace, job_dir)

    input_path = os.path.join(job_dir, f"input{ext}")
    try:
        size = 0
        with open(input_path, "wb") as f:
            while chunk := await dem_file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"Upload exceeds the {MAX_UPLOAD_BYTES // (1024**3)} GB limit.",
                    )
                f.write(chunk)
    finally:
        await dem_file.close()

    # --- Resolve 'match_raster' against the raster's own native CRS (only
    # known now that the file is on disk), then run the geodesic plausibility
    # check -- common to all three modes -- before the expensive reprojection
    # /processing work below. ---
    try:
        if origin_mode == "match_raster":
            x, y = parse_xy_pair(origin_value)
            native_crs = get_raster_crs(input_path)
            origin_lon, origin_lat = normalize_origin_to_wgs84(x, y, native_crs)

        raster_bounds_wgs84 = get_raster_bounds_wgs84(input_path)
        check_origin_within_threshold(
            origin_lon, origin_lat, raster_bounds_wgs84, threshold_meters=ORIGIN_THRESHOLD_METERS
        )
    except (InvalidCRSError, InvalidOriginError) as e:
        raise HTTPException(status_code=422, detail=str(e))

    # --- Reproject the raster to EPSG:4326 if it isn't already, so it's
    # guaranteed to agree with the origin point resolved above ---
    reprojected_path = os.path.join(job_dir, "input_wgs84.tif")
    try:
        prep = ensure_wgs84_raster(input_path, reprojected_path)
    except InvalidCRSError as e:
        raise HTTPException(status_code=422, detail=str(e))
    working_path = prep.path

    output_path = os.path.join(job_dir, "output.gpkg")

    # --- Run the (blocking, CPU-bound) backend pipeline off the event loop ---
    try:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            await run_in_threadpool(
                process_dem,
                file_path=working_path,
                origin_coords=(origin_lon, origin_lat),
                tilt_azimuth=tilt_azimuth,
                tilt_factor=tilt_factor,
                target_elevation=target_elevation,
                output_gpkg_path=output_path,
                include_dem=include_dem,
            )
        backend_warnings = [str(w.message) for w in caught]
    except FileNotFoundError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except ValueError as e:
        # e.g. target_elevation outside the DEM's actual elevation range
        raise HTTPException(status_code=422, detail=str(e))
    except IOError as e:
        # e.g. corrupted/unreadable GeoTIFF
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Processing failed: {e}")

    headers = {}
    if prep.was_reprojected:
        headers["X-Source-CRS-Reprojected-From"] = prep.original_crs
    if backend_warnings:
        # Surface backend UserWarnings (e.g. origin outside raster extent,
        # missing nodata value) to the client rather than only to server logs.
        headers["X-Processing-Warnings"] = " | ".join(backend_warnings)[:2000]

    return FileResponse(
        output_path,
        media_type="application/geopackage+sqlite3",
        filename="strandlines.gpkg",
        headers=headers,
        background=background_tasks,
    )


@app.get("/health")
async def health():
    return {"status": "ok"}
