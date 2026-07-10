"""
API layer for the GIA Modeling Tool.

One endpoint, POST /process, wraps app.process_dem with:
  - multipart file upload for the DEM
  - CRS-flexible origin point input (any CRS the client names, normalized
    to EPSG:4326 -- see api/crs.py)
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
    InvalidCRSError,
    InvalidOriginError,
)
from api.storage import create_job_workspace, cleanup_job_workspace  # noqa: E402

app = FastAPI(title="GIA Modeling Tool API")

ALLOWED_EXTENSIONS = {".tif", ".tiff"}
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024  # 2 GB; adjust to your real ceiling


@app.post("/process")
async def process(
    background_tasks: BackgroundTasks,
    dem_file: UploadFile = File(..., description="Input DEM as a GeoTIFF (.tif/.tiff)"),
    origin_x: float = Form(..., description="Tilt origin X (e.g. longitude, or easting)"),
    origin_y: float = Form(..., description="Tilt origin Y (e.g. latitude, or northing)"),
    origin_crs: str = Form(
        "EPSG:4326",
        description="CRS of origin_x/origin_y, e.g. 'EPSG:4326' or 'EPSG:32612'",
    ),
    tilt_azimuth: float = Form(..., description="Tilt direction, degrees"),
    tilt_factor: float = Form(..., description="Meters of elevation change per km"),
    target_elevation: float = Form(..., description="Paleo-elevation to contour, meters"),
    include_dem: bool = Form(
        True, description="Also embed the tilted DEM as a raster layer in the output"
    ),
):
    # --- Validate the upload up front, before touching disk ---
    filename = dem_file.filename or ""
    ext = os.path.splitext(filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=422,
            detail=f"Unsupported file type '{ext}'. Expected one of {sorted(ALLOWED_EXTENSIONS)}.",
        )

    # --- Normalize the origin point to EPSG:4326 up front too, so a bad
    # CRS/coordinate fails fast instead of after an expensive upload+reproject ---
    try:
        origin_lon, origin_lat = normalize_origin_to_wgs84(origin_x, origin_y, origin_crs)
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

    # --- Reproject the raster to EPSG:4326 if it isn't already, so it's
    # guaranteed to agree with the origin point normalized above ---
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
