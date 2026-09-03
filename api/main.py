"""
API layer for the GIA Modeling Tool.

One endpoint, POST /process, wraps backend.app.process_dem with:
  - multipart file upload for the DEM
  - three explicit, unambiguous origin input modes (origin_mode /
    origin_value / origin_epsg -- see api/crs.py and
    documentation/api-README.md),
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
import io
import os
import sys
import warnings
import zipfile

import geopandas as gpd
import rasterio.errors
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks
from fastapi.responses import Response
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

# Make the repo root (parent of the backend/ package) importable regardless
# of where uvicorn is launched from.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.app import process_dem  # noqa: E402  (import after sys.path fixup, see above)
from backend.main import raster_io_check, check_available_ram_mb  # noqa: E402

from api.crs import (  # noqa: E402
    normalize_origin_to_wgs84,
    ensure_wgs84_raster,
    parse_xy_pair,
    parse_decimal_degrees_hemisphere,
    get_raster_crs,
    get_raster_bounds_wgs84,
    get_raster_diagonal_km,
    check_origin_within_threshold,
    sample_elevation_at_point,
    InvalidCRSError,
    InvalidOriginError,
)
from api.storage import create_job_workspace, cleanup_job_workspace, job_workspace  # noqa: E402
from api.raster_preview import build_preview_geotiff_bytes  # noqa: E402

app = FastAPI(title="GIA Modeling Tool API")

ALLOWED_EXTENSIONS = {".tif", ".tiff"}
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024  # 2 GB; adjust to your real ceiling

ORIGIN_MODES = {"match_raster", "decimal_degrees", "epsg"}
ORIGIN_THRESHOLD_METERS = 500.0


@app.post("/api/process")
async def process(
    background_tasks: BackgroundTasks,
    dem_file: UploadFile | None = File(None, description="Input DEM as a GeoTIFF (.tif/.tiff)"),
    file_path: str | None = Form(None, description="Server-side path to a GeoTIFF on the same pod filesystem"),
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
    # --- Validate the input shape and the origin shape up front, before touching disk ---
    if (dem_file is None) == (file_path is None):
        raise HTTPException(
            status_code=422,
            detail="Provide exactly one of dem_file or file_path.",
        )

    filename = dem_file.filename if dem_file is not None else file_path
    ext = os.path.splitext(filename or "")[1].lower()
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

    if dem_file is not None:
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
    else:
        if not os.path.isfile(file_path):
            raise HTTPException(
                status_code=400,
                detail=f"Could not find a file at '{file_path}'.",
            )
        input_path = file_path

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

    # --- The tilt plane pivots through the origin, so the tilted DEM's value
    # there is always identical to the raw DEM's -- a submitted
    # target_elevation that disagrees produces a strandline that doesn't pass
    # through the origin at all. When the DEM has valid data at the origin,
    # its own value is authoritative; manual entry only applies where there's
    # nothing to sample (origin outside the DEM, or on a nodata cell). ---
    sampled_elevation = sample_elevation_at_point(working_path, origin_lon, origin_lat)
    if sampled_elevation is not None:
        effective_target_elevation = sampled_elevation
    else:
        effective_target_elevation = target_elevation

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
                target_elevation=effective_target_elevation,
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
        # `simplefilter("always")` above records every warning category, not
        # just this codebase's own UserWarnings -- a library-internal
        # DeprecationWarning can slip in with embedded newlines in its
        # message, which are invalid in an HTTP header value and crash the
        # response at send time (only visible over a real ASGI server, not
        # the in-process calls the test suite uses). Collapse whitespace
        # defensively so header construction never depends on what a given
        # warning happens to say.
        sanitized_warnings = [" ".join(w.split()) for w in backend_warnings]
        headers["X-Processing-Warnings"] = " | ".join(sanitized_warnings)[:2000]
    if sampled_elevation is not None:
        headers["X-Target-Elevation-Source"] = "dem"
        if abs(sampled_elevation - target_elevation) > 1e-6:
            headers["X-Target-Elevation-Note"] = (
                f"Target elevation was set to {sampled_elevation:.2f} m (from the DEM at "
                f"the origin) instead of the entered value of {target_elevation:.2f} m."
            )
    else:
        headers["X-Target-Elevation-Source"] = "manual"

    # --- Bundle strandlines.gpkg alongside two small, cheap-to-derive
    # preview artifacts for the map's result-preview panel (see
    # documentation/VISUALIZATION_PIPELINE_SPEC.md Stage 3). Both are read back from the
    # .gpkg process_dem() just finished writing -- a small vector-layer read
    # and a decimated raster-table read, not a re-run of tilt/contour
    # computation -- rather than threading extra return values through
    # process_dem() itself, which stays untouched (see CLAUDE.md). ---
    contour_gdf = gpd.read_file(output_path, layer="strandline_contour")
    zip_buffer = io.BytesIO()
    # ZIP_STORED (no compression), not ZIP_DEFLATED: measured on a real 440MB
    # output, deflate spent ~19s to recover only a 5% size reduction --
    # elevation rasters and WKB geometry don't compress well. See
    # documentation/PERFORMANCE_OPTIMIZATION_SPEC.md Fix 3.
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_STORED) as zf:
        zf.write(output_path, arcname="strandlines.gpkg")
        zf.writestr("contour.geojson", contour_gdf.to_json())
        if include_dem:
            preview_bytes = build_preview_geotiff_bytes(f"GPKG:{output_path}:modified_dem")
            zf.writestr("preview_tilted.tif", preview_bytes)

    headers["Content-Disposition"] = 'attachment; filename="results.zip"'

    return Response(
        content=zip_buffer.getvalue(),
        media_type="application/zip",
        headers=headers,
        background=background_tasks,
    )


@app.post("/api/preflight")
async def preflight(
    background_tasks: BackgroundTasks,
    dem_file: UploadFile | None = File(None, description="Input DEM as a GeoTIFF (.tif/.tiff)"),
    file_path: str | None = Form(None, description="Server-side path to a GeoTIFF on the same pod filesystem"),
):
    # --- Metadata-only check: reuses raster_io_check's own cost profile, so
    # this stays cheap enough to fire on drop / on blur. No reprojection or
    # origin resolution here -- that's /process's job. ---
    if (dem_file is None) == (file_path is None):
        raise HTTPException(
            status_code=422,
            detail="Provide exactly one of dem_file or file_path.",
        )

    filename = dem_file.filename if dem_file is not None else file_path
    ext = os.path.splitext(filename or "")[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=422,
            detail=f"Unsupported file type '{ext}'. Expected one of {sorted(ALLOWED_EXTENSIONS)}.",
        )

    if dem_file is not None:
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
    else:
        if not os.path.isfile(file_path):
            raise HTTPException(
                status_code=400,
                detail=f"Could not find a file at '{file_path}'.",
            )
        input_path = file_path

    try:
        free_ram = check_available_ram_mb()
        io_check = raster_io_check(input_path, free_ram)
        crs = get_raster_crs(input_path)
        bounds_wgs84 = get_raster_bounds_wgs84(input_path)
        diagonal_km = get_raster_diagonal_km(input_path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except IOError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except InvalidCRSError as e:
        raise HTTPException(status_code=422, detail=str(e))

    return {
        "crs": crs,
        "bounds_wgs84": list(bounds_wgs84),
        "diagonal_km": diagonal_km,
        "band_count": io_check["band_count"],
        "use_windowed_io": io_check["use_windowed_io"],
        "needs_casting": io_check["needs_casting"],
        "peak_ram_mb": io_check["peak_ram_mb"],
    }


@app.post("/api/raster-preview")
async def raster_preview(
    background_tasks: BackgroundTasks,
    dem_file: UploadFile | None = File(None, description="Input DEM as a GeoTIFF (.tif/.tiff)"),
    file_path: str | None = Form(None, description="Server-side path to a GeoTIFF on the same pod filesystem"),
):
    # --- Same dual file-resolution as /api/preflight. Fires once after
    # preflight succeeds (not on every keystroke) -- decimation keeps this
    # cheap regardless of the source file's actual size. ---
    if (dem_file is None) == (file_path is None):
        raise HTTPException(
            status_code=422,
            detail="Provide exactly one of dem_file or file_path.",
        )

    filename = dem_file.filename if dem_file is not None else file_path
    ext = os.path.splitext(filename or "")[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=422,
            detail=f"Unsupported file type '{ext}'. Expected one of {sorted(ALLOWED_EXTENSIONS)}.",
        )

    if dem_file is not None:
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
    else:
        if not os.path.isfile(file_path):
            raise HTTPException(
                status_code=400,
                detail=f"Could not find a file at '{file_path}'.",
            )
        input_path = file_path

    try:
        preview_bytes = build_preview_geotiff_bytes(input_path)
    except InvalidCRSError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except rasterio.errors.RasterioIOError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return Response(content=preview_bytes, media_type="image/tiff", background=background_tasks)


class ResolvePointRequest(BaseModel):
    origin_mode: str
    origin_value: str
    origin_epsg: str | None = None
    native_crs: str | None = None


@app.post("/api/resolve-point")
async def resolve_point(body: ResolvePointRequest):
    # --- Cheap coordinate resolution, no file I/O: wraps the same parsing
    # functions /api/process uses for the two origin modes that don't
    # depend on the raster itself. 'match_raster' is also supported here
    # (unlike at the top of /api/process, where it's deferred until the
    # file is on disk) because the client already has the raster's CRS
    # cached from /api/preflight's response -- no raster re-read needed for
    # a live map preview on every coordinate-field blur. ---
    if body.origin_mode not in ORIGIN_MODES:
        raise HTTPException(
            status_code=422,
            detail=f"origin_mode must be one of {sorted(ORIGIN_MODES)}, got '{body.origin_mode}'.",
        )

    try:
        if body.origin_mode == "decimal_degrees":
            lon, lat = parse_decimal_degrees_hemisphere(body.origin_value)
        elif body.origin_mode == "epsg":
            if not body.origin_epsg:
                raise HTTPException(
                    status_code=422,
                    detail="origin_epsg is required when origin_mode is 'epsg'.",
                )
            x, y = parse_xy_pair(body.origin_value)
            lon, lat = normalize_origin_to_wgs84(x, y, body.origin_epsg)
        else:  # match_raster
            if not body.native_crs:
                raise HTTPException(
                    status_code=422,
                    detail="native_crs is required when origin_mode is 'match_raster'.",
                )
            x, y = parse_xy_pair(body.origin_value)
            lon, lat = normalize_origin_to_wgs84(x, y, body.native_crs)
    except (InvalidCRSError, InvalidOriginError) as e:
        raise HTTPException(status_code=422, detail=str(e))

    return {"lon": lon, "lat": lat}


@app.post("/api/origin-elevation")
async def origin_elevation(
    dem_file: UploadFile | None = File(None, description="Input DEM as a GeoTIFF (.tif/.tiff)"),
    file_path: str | None = Form(None, description="Server-side path to a GeoTIFF on the same pod filesystem"),
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
):
    # --- Preview-only: reports the DEM's own elevation at the resolved
    # origin, using the same sampling /api/process uses to authoritatively
    # override target_elevation. This lets the frontend show the value
    # before a full run, but /api/process never trusts this endpoint's
    # output -- it re-derives everything independently. ---
    if (dem_file is None) == (file_path is None):
        raise HTTPException(
            status_code=422,
            detail="Provide exactly one of dem_file or file_path.",
        )

    filename = dem_file.filename if dem_file is not None else file_path
    ext = os.path.splitext(filename or "")[1].lower()
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

    origin_lon = origin_lat = None
    try:
        if origin_mode == "decimal_degrees":
            origin_lon, origin_lat = parse_decimal_degrees_hemisphere(origin_value)
        elif origin_mode == "epsg":
            x, y = parse_xy_pair(origin_value)
            origin_lon, origin_lat = normalize_origin_to_wgs84(x, y, origin_epsg)
    except (InvalidCRSError, InvalidOriginError) as e:
        raise HTTPException(status_code=422, detail=str(e))

    with job_workspace() as job_dir:
        if dem_file is not None:
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
        else:
            if not os.path.isfile(file_path):
                raise HTTPException(
                    status_code=400,
                    detail=f"Could not find a file at '{file_path}'.",
                )
            input_path = file_path

        # --- Resolve 'match_raster' against the raster's own native CRS, then
        # reproject to EPSG:4326 -- same working raster /api/process would
        # actually tilt -- before sampling, per the "which raster to sample
        # against" subtlety: consistency with the real pipeline matters more
        # than avoiding the reprojection cost here. ---
        try:
            if origin_mode == "match_raster":
                x, y = parse_xy_pair(origin_value)
                native_crs = get_raster_crs(input_path)
                origin_lon, origin_lat = normalize_origin_to_wgs84(x, y, native_crs)

            reprojected_path = os.path.join(job_dir, "input_wgs84.tif")
            prep = ensure_wgs84_raster(input_path, reprojected_path)
        except (InvalidCRSError, InvalidOriginError) as e:
            raise HTTPException(status_code=422, detail=str(e))
        except FileNotFoundError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except IOError as e:
            raise HTTPException(status_code=400, detail=str(e))

        working_path = prep.path

        # --- sample_elevation_at_point already returns None for genuinely
        # out-of-grid points, so a separate strict bounds check is only
        # needed to tell "outside_bounds" apart from "nodata" once sampling
        # comes back empty -- not on the (common) successful-sample path. ---
        elevation = sample_elevation_at_point(working_path, origin_lon, origin_lat)
        if elevation is not None:
            return {"within_bounds": True, "elevation": elevation, "reason": None}

        west, south, east, north = get_raster_bounds_wgs84(working_path)
        if west <= origin_lon <= east and south <= origin_lat <= north:
            return {"within_bounds": True, "elevation": None, "reason": "nodata"}
        return {"within_bounds": False, "elevation": None, "reason": "outside_bounds"}


@app.get("/api/health")
async def health():
    return {"status": "ok"}


# --- Serve the built frontend as static files, so the API and the UI share
# one process/port -- required for the jupyter-server-proxy deployment path
# (see CLAUDE.md). Mounted last, and at the very end of this module after
# every route decorator above: mount order matters in Starlette, and a root
# mount registered first would shadow the /api/* routes. The isdir guard
# means `uvicorn api.main:app --reload` still works before `npm run build`
# has been run -- it just won't serve anything at "/" yet. ---
from fastapi.staticfiles import StaticFiles  # noqa: E402

_frontend_dist = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "frontend", "dist",
)
if os.path.isdir(_frontend_dist):
    app.mount("/", StaticFiles(directory=_frontend_dist, html=True), name="frontend")
