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
import csv
import datetime
import functools
import io
import json
import math
import os
import re
import subprocess
import sys
import warnings
import zipfile
from typing import Annotated, Any

import geopandas as gpd
import numpy as np
import rasterio
import rasterio.errors
import rasterio.transform
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks
from fastapi.responses import Response
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

# Make the repo root (parent of the backend/ package) importable regardless
# of where uvicorn is launched from.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.app import process_dem  # noqa: E402  (import after sys.path fixup, see above)
from backend.main import raster_io_check, check_available_ram_mb, uplift_d_range_km  # noqa: E402
from backend.uplift import build_uplift_model  # noqa: E402
from backend.direction_field import build_vector_model_from_spec, isobases_geojson  # noqa: E402
from backend.uplift_surface import (  # noqa: E402
    build_surface_model_from_spec, surface_isobases_geojson, unscaled_coeffs,
)

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
from api.tilt_model import (  # noqa: E402
    TiltModelError, parse_tilt_model, validate_tilt_model, require_direction_inputs,
)

app = FastAPI(title="GIA Modeling Tool API")

ALLOWED_EXTENSIONS = {".tif", ".tiff"}
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024  # 2 GB; adjust to your real ceiling

ORIGIN_MODES = {"match_raster", "decimal_degrees", "epsg"}
ORIGIN_THRESHOLD_METERS = 500.0

RUN_PARAMETERS_SCHEMA_VERSION = 1
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@functools.lru_cache(maxsize=1)
def _git_commit() -> str | None:
    """The app's git commit, for run_parameters.json -- None when git or the
    repo metadata isn't available (never worth failing a run over)."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=_REPO_ROOT, capture_output=True, text=True, timeout=2,
        )
        commit = out.stdout.strip()
        return commit if out.returncode == 0 and commit else None
    except Exception:
        return None


def _public_diagnostics(diagnostics: dict) -> dict:
    """The JSON-safe part of a vector model's diagnostics (drops the phi grid)."""
    g = diagnostics["grid"]
    return {
        "case": diagnostics["case"],
        "misfit_deg": diagnostics["misfit_deg"],
        "misfit_rms_deg": diagnostics["misfit_rms_deg"],
        "misfit_max_deg": diagnostics["misfit_max_deg"],
        "worst_vector": diagnostics["worst_vector"],
        "degenerate_fraction": diagnostics["degenerate_fraction"],
        "ranges_km": diagnostics["ranges_km"],
        "grid": {"h_km": g["h"], "nx": g["nx"], "ny": g["ny"]},
    }


def _finite_or_none(value):
    """JSON has no Infinity/NaN: a degenerate design's condition number becomes null."""
    return float(value) if value is not None and math.isfinite(value) else None


def _fit_summary(fit: dict) -> dict:
    """A fit's headline statistics (one row of the order-comparison table)."""
    return {
        "order": fit["order"], "n": fit["n"], "terms": fit["terms"],
        "r2": _finite_or_none(fit["r2"]), "adj_r2": _finite_or_none(fit["adj_r2"]),
        "rmse_m": _finite_or_none(fit["rmse_m"]),
    }


def _selected_fit(fit: dict) -> dict:
    return {
        **_fit_summary(fit),
        "cond": _finite_or_none(fit["cond"]),
        "residuals_m": fit["residuals_m"],
        "std_residuals": fit["std_residuals"],
        "outlier_indices": fit["outlier_indices"],
    }


def _public_surface_diagnostics(diagnostics: dict) -> dict:
    """The JSON-safe part of a shore-point surface's diagnostics, for
    run_parameters.json: the full fit statistics and coefficients. S is in
    meters a.s.l. as a polynomial of the local frame's east/north km
    (`per_km`); `scaled` are the coefficients of the (e/L, n/L) basis actually solved."""
    fit = diagnostics["fit"]
    per_km = unscaled_coeffs(fit)
    return {
        "type": "points",
        "fit": {
            **_selected_fit(fit),
            "L_km": fit["L"],
            "coefficients": [
                {"east_power": a, "north_power": b, "scaled": c, "per_km": per_km[(a, b)]}
                for (a, b), c in zip(fit["monomials"], fit["coeffs"])
            ],
        },
        "orders": [_fit_summary(f) for f in diagnostics["orders"]],
        "dem_fraction_outside_hull": diagnostics["dem_fraction_outside_hull"],
        "origin_inside_hull": diagnostics["origin_inside_hull"],
    }


def _shore_points_csv(direction: dict, residuals_m: list) -> str:
    """The points a run fitted, so the bundle alone reproduces it. Re-importable:
    the header names are ones the frontend's importer matches."""
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(["lat", "lon", "elevation_m", "label", "residual_m"])
    for p, r in zip(direction["points"], residuals_m):
        writer.writerow([repr(p["lat"]), repr(p["lon"]), repr(p["elevation_m"]),
                         p.get("label") or "", repr(float(r))])
    return out.getvalue()


def _input_file_name(filename: str | None) -> str | None:
    """Bare file name only -- a server path could reveal a private pod layout."""
    if not filename:
        return None
    return re.split(r"[\\/]", filename)[-1] or None


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
    # Optional in the signature so a `vectors` model can omit them (each is
    # required by require_direction_inputs when it applies); Annotated, like
    # tilt_model below, so a direct in-process call that omits one gets a real None.
    tilt_azimuth: Annotated[
        float | None,
        Form(description="Tilt direction, degrees (required unless the model's direction is 'vectors')"),
    ] = None,
    tilt_factor: Annotated[
        float | None,
        Form(description=(
            "Meters of elevation change per km at the spillway (required unless every vector has "
            "a custom tilt)"
        )),
    ] = None,
    target_elevation: float = Form(..., description="Paleo-elevation to contour, meters"),
    include_dem: bool = Form(
        True, description="Also embed the tilted DEM as a raster layer in the output"
    ),
    selection_radius_km: float | None = Form(
        None, description="Optional: keep only strandline contours within this many km of the origin"
    ),
    # Annotated (not `= Form(None)`) so a direct in-process call that omits it
    # -- as the test suite and smoke test do -- gets a real None.
    tilt_model: Annotated[
        str | None,
        Form(description=(
            "Optional JSON uplift model (profile family + hinge); absent means the basic linear "
            "tilt. See documentation/api-README.md."
        )),
    ] = None,
):
    # --- Validate the input shape and the origin shape up front, before touching disk ---
    if selection_radius_km is not None and (
        not math.isfinite(selection_radius_km) or selection_radius_km <= 0
    ):
        raise HTTPException(
            status_code=422,
            detail="selection_radius_km must be a finite number greater than 0.",
        )

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

    # --- Parse the optional uplift model and build it now, so a bad or
    # unbuildable model fails fast, before any upload is written. ---
    # A `vectors` model needs the raster's own geometry, so it is built further
    # down, once the working raster exists.
    parsed_tilt_model = None
    uplift_model = None
    try:
        if tilt_model is not None:
            parsed_tilt_model = parse_tilt_model(tilt_model, tilt_factor, tilt_azimuth)
            if parsed_tilt_model["direction"]["type"] == "azimuth":
                uplift_model = build_uplift_model(parsed_tilt_model, tilt_azimuth, tilt_factor)
        else:
            require_direction_inputs(None, tilt_azimuth, tilt_factor)
    except (TiltModelError, ValueError) as e:
        raise HTTPException(status_code=422, detail=str(e))

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

    # --- Vector direction field: build the uplift model once, from the working
    # raster's own transform and shape (the same object then serves every block,
    # windowed or not). Its warnings and diagnostics ride along with the run's. ---
    build_warnings = []
    diagnostics = None
    if parsed_tilt_model is not None and parsed_tilt_model["direction"]["type"] == "vectors":
        try:
            with rasterio.open(working_path) as src:
                transform, shape = src.transform, (src.height, src.width)
            with warnings.catch_warnings(record=True) as built:
                warnings.simplefilter("always")
                uplift_model, diagnostics = await run_in_threadpool(
                    build_vector_model_from_spec, parsed_tilt_model, tilt_factor,
                    (origin_lon, origin_lat), transform, shape,
                )
            build_warnings = [str(w.message) for w in built]
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e))

    # --- Shore-point surface: built here for the same reason (it needs the working
    # raster's geometry, and its frame must match the run's exactly). ---
    surface_diagnostics = None
    if parsed_tilt_model is not None and parsed_tilt_model["direction"]["type"] == "points":
        try:
            with rasterio.open(working_path) as src:
                transform, shape = src.transform, (src.height, src.width)
            with warnings.catch_warnings(record=True) as built:
                warnings.simplefilter("always")
                uplift_model, surface_diagnostics = await run_in_threadpool(
                    build_surface_model_from_spec, parsed_tilt_model,
                    (origin_lon, origin_lat), transform, shape,
                )
            build_warnings = [str(w.message) for w in built]
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e))

    output_path = os.path.join(job_dir, "output.gpkg")

    # --- Run the (blocking, CPU-bound) backend pipeline off the event loop ---
    try:
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            await run_in_threadpool(
                process_dem,
                file_path=working_path,
                origin_coords=(origin_lon, origin_lat),
                # Ignored by the math whenever a model is given (vectors mode may omit them).
                tilt_azimuth=0.0 if tilt_azimuth is None else tilt_azimuth,
                tilt_factor=0.0 if tilt_factor is None else tilt_factor,
                target_elevation=effective_target_elevation,
                output_gpkg_path=output_path,
                include_dem=include_dem,
                selection_radius_km=selection_radius_km,
                uplift_model=uplift_model,
            )
        backend_warnings = build_warnings + [str(w.message) for w in caught]
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
    if diagnostics is not None:
        headers["X-Tilt-Model-Diagnostics"] = json.dumps({
            "misfit_rms_deg": diagnostics["misfit_rms_deg"],
            "misfit_max_deg": diagnostics["misfit_max_deg"],
            "worst_vector": diagnostics["worst_vector"],  # 0-based index into the submitted vectors
        })
    if surface_diagnostics is not None:
        fit = surface_diagnostics["fit"]
        headers["X-Tilt-Model-Diagnostics"] = json.dumps({
            "order": fit["order"],
            "r2": _finite_or_none(fit["r2"]),
            "rmse_m": _finite_or_none(fit["rmse_m"]),
            "dem_fraction_outside_hull": surface_diagnostics["dem_fraction_outside_hull"],
        })
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
    if selection_radius_km is not None:
        headers["X-Selection-Summary"] = (
            f"{len(contour_gdf)} strandline contour(s) kept within "
            f"{selection_radius_km:g} km of the origin."
        )
    zip_buffer = io.BytesIO()
    # ZIP_STORED (no compression), not ZIP_DEFLATED: measured on a real 440MB
    # output, deflate spent ~19s to recover only a 5% size reduction --
    # elevation rasters and WKB geometry don't compress well. See
    # documentation/PERFORMANCE_OPTIMIZATION_SPEC.md Fix 3.
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_STORED) as zf:
        zf.write(output_path, arcname="strandlines.gpkg")
        zf.writestr("contour.geojson", contour_gdf.to_json())
        zf.writestr("run_parameters.json", json.dumps({
            "schema_version": RUN_PARAMETERS_SCHEMA_VERSION,
            "app_commit": _git_commit(),
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "input_file": _input_file_name(filename),
            "origin": {"lon": origin_lon, "lat": origin_lat},
            "effective_target_elevation": effective_target_elevation,
            "target_elevation_source": "dem" if sampled_elevation is not None else "manual",
            "submitted_target_elevation": target_elevation,
            "tilt_azimuth": tilt_azimuth,
            "tilt_factor": tilt_factor,
            "tilt_model": parsed_tilt_model,
            # Where uplift stops changing behind the spillway (km, negative) and
            # what set it: 'mode' (the hinge mode) or 'guard' (the gradient
            # reached zero first). Null for a basic run, or an unclamped profile.
            "hinge_km": None if uplift_model is None else uplift_model.hinge_d,
            "hinge_source": None if uplift_model is None else uplift_model.hinge_source,
            # Vectors mode only: fit quality of the direction field (per-vector
            # misfit, degrees; null for a vector outside the working grid).
            # Vectors mode: per-vector misfit. Points mode: the full fit statistics
            # and coefficients (the points themselves are in shore_points.csv).
            "diagnostics": (
                _public_diagnostics(diagnostics) if diagnostics is not None
                else None if surface_diagnostics is None
                else _public_surface_diagnostics(surface_diagnostics)
            ),
            "include_dem": include_dem,
            "selection_radius_km": selection_radius_km,
            "reprojected": {
                "was_reprojected": bool(prep.was_reprojected),
                "from_crs": prep.original_crs if prep.was_reprojected else None,
            },
        }, indent=2))
        if surface_diagnostics is not None:
            zf.writestr("shore_points.csv", _shore_points_csv(
                parsed_tilt_model["direction"], surface_diagnostics["fit"]["residuals_m"]))
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


def _check_origin_and_bounds(origin, bounds_wgs84):
    if origin is not None and (len(origin) != 2 or not all(math.isfinite(v) for v in origin)):
        raise HTTPException(status_code=422, detail="origin must be [lon, lat] (finite numbers).")
    if bounds_wgs84 is not None:
        b = bounds_wgs84
        if len(b) != 4 or not all(math.isfinite(v) for v in b) or b[0] >= b[2] or b[1] >= b[3]:
            raise HTTPException(
                status_code=422,
                detail="bounds_wgs84 must be [west, south, east, north] with west < east and south < north.",
            )


class ProfilePreviewRequest(BaseModel):
    tilt_azimuth: float
    tilt_factor: float
    tilt_model: dict
    origin: list[float] | None = None  # [lon, lat]
    bounds_wgs84: list[float] | None = None  # [west, south, east, north]
    samples: int = 121


NOMINAL_D_RANGE_KM = (-100.0, 100.0)


@app.post("/api/profile-preview")
async def profile_preview(body: ProfilePreviewRequest):
    # --- Pure math, no raster I/O: the uplift-vs-distance curve the run would
    # apply, for the Advanced form's chart. Uses the same validation and
    # model-building as /api/process, and the same local frame for the
    # d-range, so the preview and the run agree. ---
    if not (2 <= body.samples <= 2000):
        raise HTTPException(status_code=422, detail="samples must be between 2 and 2000.")
    _check_origin_and_bounds(body.origin, body.bounds_wgs84)

    try:
        parsed = validate_tilt_model(body.tilt_model, body.tilt_factor, body.tilt_azimuth)
        if parsed["direction"]["type"] != "azimuth":
            use = ("/api/fit-uplift-surface" if parsed["direction"]["type"] == "points"
                   else "/api/uplift-preview")
            raise TiltModelError(
                f"/api/profile-preview is for direction.type 'azimuth'; use {use} "
                f"for '{parsed['direction']['type']}'."
            )
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            model = build_uplift_model(parsed, body.tilt_azimuth, body.tilt_factor)
            if body.origin is not None and body.bounds_wgs84 is not None:
                d_min, d_max = uplift_d_range_km(model, tuple(body.origin), body.bounds_wgs84)
                nominal = False
            else:
                d_min, d_max = NOMINAL_D_RANGE_KM
                nominal = True
            model.warn_for_range(d_min, d_max)
        messages = [str(w.message) for w in caught]
        if nominal:
            messages.append(
                "The distance range is nominal (-100 to 100 km) because the origin or DEM "
                "extent is not available yet."
            )
    except (TiltModelError, ValueError) as e:
        raise HTTPException(status_code=422, detail=str(e))

    d = np.linspace(d_min, d_max, body.samples)
    with np.errstate(over="ignore", invalid="ignore"):  # absurd coefficients: caught just below
        uplift = model.uplift_at_distance(d)
        gradient = model.gradient_at_distance(d)
    if not (np.all(np.isfinite(uplift)) and np.all(np.isfinite(gradient))):
        raise HTTPException(
            status_code=422,
            detail="The profile evaluates to non-finite values over the DEM's distance range.",
        )

    return {
        "d_km": d.tolist(),
        "uplift_m": uplift.tolist(),
        "gradient_m_per_km": gradient.tolist(),
        "d_range_km": [float(d_min), float(d_max)],
        "hinge_km": model.hinge_d,
        "hinge_source": model.hinge_source,
        "warnings": list(dict.fromkeys(messages)),
    }


class UpliftPreviewRequest(BaseModel):
    tilt_azimuth: float | None = None
    tilt_factor: float | None = None
    tilt_model: dict
    origin: list[float]  # [lon, lat]
    bounds_wgs84: list[float]  # [west, south, east, north]


# Only the bounds matter to the working grid, not the pixel counts.
PREVIEW_RASTER_SHAPE = (512, 512)


def _build_uplift_preview(parsed, tilt_factor, origin, bounds):
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        transform = rasterio.transform.from_bounds(*bounds, PREVIEW_RASTER_SHAPE[1], PREVIEW_RASTER_SHAPE[0])
        model, diagnostics = build_vector_model_from_spec(
            parsed, tilt_factor, tuple(origin), transform, PREVIEW_RASTER_SHAPE,
        )
    isobases, interval = isobases_geojson(model, diagnostics)
    return diagnostics, isobases, interval, [str(w.message) for w in caught]


@app.post("/api/uplift-preview")
async def uplift_preview(body: UpliftPreviewRequest):
    # --- No raster I/O: the isobases and fit quality a `vectors` run would
    # produce, for the map. The grid is built from the preflight bounds through
    # the same code the run uses, so the two agree exactly for an EPSG:4326 DEM
    # (and negligibly differ for a reprojected one; the run is authoritative). ---
    _check_origin_and_bounds(body.origin, body.bounds_wgs84)

    try:
        parsed = validate_tilt_model(body.tilt_model, body.tilt_factor, body.tilt_azimuth)
        if parsed["direction"]["type"] != "vectors":
            raise TiltModelError(
                "/api/uplift-preview is for direction.type 'vectors'; use /api/profile-preview "
                "for a single azimuth, or /api/fit-uplift-surface for shore points."
            )
        diagnostics, isobases, interval, messages = await run_in_threadpool(
            _build_uplift_preview, parsed, body.tilt_factor, body.origin, body.bounds_wgs84,
        )
    except (TiltModelError, ValueError) as e:
        raise HTTPException(status_code=422, detail=str(e))

    return {
        "isobases": isobases,
        "interval_m": interval,
        "vectors": [
            {"index": i, "misfit_deg": m} for i, m in enumerate(diagnostics["misfit_deg"])
        ],
        "misfit_rms_deg": diagnostics["misfit_rms_deg"],
        "misfit_max_deg": diagnostics["misfit_max_deg"],
        "worst_vector": diagnostics["worst_vector"],
        "degenerate_fraction": diagnostics["degenerate_fraction"],
        "hinge_km": diagnostics["hinge_km"],
        "hinge_source": diagnostics["hinge_source"],
        "warnings": list(dict.fromkeys(messages)),
    }


class FitSurfaceRequest(BaseModel):
    points: list[dict]  # [{lat, lon, elevation_m, label?}]; validated by api/tilt_model.py
    order: Any
    origin: list[float]  # [lon, lat]
    bounds_wgs84: list[float]  # [west, south, east, north]
    hinge: Any = None  # 'none' | 'origin'
    extrapolation: Any = None  # 'warn' | 'mask'


def _build_surface_preview(parsed, origin, bounds):
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        transform = rasterio.transform.from_bounds(*bounds, PREVIEW_RASTER_SHAPE[1], PREVIEW_RASTER_SHAPE[0])
        model, diagnostics = build_surface_model_from_spec(
            parsed, tuple(origin), transform, PREVIEW_RASTER_SHAPE,
        )
    isobases, interval, hull = surface_isobases_geojson(model, diagnostics)
    return diagnostics, isobases, interval, hull, [str(w.message) for w in caught]


@app.post("/api/fit-uplift-surface")
async def fit_uplift_surface(body: FitSurfaceRequest):
    # --- No raster I/O: the fit statistics (every order the point count allows),
    # residuals, isobases of the fitted surface and the data hull, for the map and
    # the tilt section. Built from the preflight bounds through the same code a run
    # uses, so it agrees exactly for an EPSG:4326 DEM (and negligibly differs for a
    # reprojected one; the run is authoritative). ---
    _check_origin_and_bounds(body.origin, body.bounds_wgs84)

    try:
        parsed = validate_tilt_model({
            "version": 1,
            "direction": {
                "type": "points", "points": body.points, "order": body.order,
                "hinge": body.hinge, "extrapolation": body.extrapolation,
            },
        }, None)
        diagnostics, isobases, interval, hull, messages = await run_in_threadpool(
            _build_surface_preview, parsed, body.origin, body.bounds_wgs84,
        )
    except (TiltModelError, ValueError) as e:
        raise HTTPException(status_code=422, detail=str(e))

    return {
        "orders": [_fit_summary(f) for f in diagnostics["orders"]],
        "selected": _selected_fit(diagnostics["fit"]),
        "isobases": isobases,
        "interval_m": interval,
        "hull": hull,
        "dem_fraction_outside_hull": diagnostics["dem_fraction_outside_hull"],
        "origin_inside_hull": diagnostics["origin_inside_hull"],
        "warnings": list(dict.fromkeys(messages)),
    }


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
