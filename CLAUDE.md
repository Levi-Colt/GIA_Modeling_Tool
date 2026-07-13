# GIA Modeling Tool — Project Context

## Architecture
- `app.py` / `main.py`: backend geoprocessing pipeline (untouched by the API layer,
  keeps its existing test suite intact). Entry point: `app.py::process_dem()`.
- `api/`: FastAPI layer wrapping the backend. Single endpoint: `POST /process`.
  See `api/README.md` for the full request/response contract.

## Key design decisions
- CRS handling lives entirely in the API layer (`api/crs.py`), never in main.py/app.py.
- Origin coordinate input supports three explicit modes (match_raster,
  decimal_degrees, epsg) rather than one ambiguous format — see api/README.md.
- A 500m geodesic distance check (via pyproj.Geod) guards against CRS mismatches
  regardless of which origin mode is used.
- Non-geographic input rasters are reprojected to EPSG:4326 server-side before
  processing, since calculate_tilt() requires geographic degrees.
- Temp storage is job-scoped, under a configurable GIA_STORAGE_DIR env var
  (defaults to OS temp dir) — environment-agnostic re: eventual CryoCloud hosting.

## Open items
- Sync vs. async processing for very large DEMs — currently synchronous
  (threadpool-backed), not yet needing a job-queue/polling pattern.
- CryoCloud deployment/exposure mechanism still undecided (JupyterHub session
  via jupyter-server-proxy vs. separate hosting).
- No auth/rate-limiting yet.

## Workflow notes
- `api/smoke_test.py` is a standalone verification script (not part of pytest),
  run with `python api/smoke_test.py` from repo root.
- Frontend: wireframing in Penpot, to be built against api/README.md's contract.