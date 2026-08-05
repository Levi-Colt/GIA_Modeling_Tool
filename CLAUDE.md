# GIA Modeling Tool — Project Context

## Architecture
- `backend/` (`app.py` / `main.py`): backend geoprocessing pipeline
  (untouched by the API layer, keeps its existing test suite intact).
  Entry point: `backend/app.py::process_dem()`. A plain package
  (`backend/__init__.py`) so `api/` can import it as `backend.app` /
  `backend.main` regardless of where a command is invoked from, as long as
  the repo root is on `sys.path` (see `api/main.py`'s `sys.path.insert`).
- `api/`: FastAPI layer wrapping the backend. Routes: `POST /api/process`,
  `POST /api/preflight`, `POST /api/resolve-point`, `POST /api/raster-preview`,
  `POST /api/origin-elevation`, `GET /api/health`.
  See `documentation/api-README.md` for the full request/response contract.
- `frontend/`: React (JS, not TS) + Vite + Tailwind + Leaflet (map panel).
  See `documentation/frontend-README.md` for structure and what's
  implemented vs. stubbed.
- `documentation/`: every markdown doc except this file and the root
  `README.md` (both stay at repo root — `CLAUDE.md` for Claude Code's
  auto-loaded project instructions, `README.md` for GitHub's rendered repo
  landing page; moving either breaks that auto-discovery). Includes the
  former `api/README.md` and `frontend/README.md` (renamed
  `api-README.md` / `frontend-README.md` to avoid a filename collision
  once co-located).
- `setup/`: `requirements.txt` / `requirements-api.txt` / `requirements-dev.txt`,
  `pytest.ini`, `environment.yml`. Since `pytest.ini` no longer lives at
  the repo root, pytest won't auto-discover it — run tests with
  `pytest -c setup/pytest.ini --rootdir=.` from the repo root (see
  Workflow notes).

## Hosting/deployment (decided)
- Target environment: CryoCloud (NASA/2i2c JupyterHub). Each user gets an
  isolated pod with private persistent storage — no shared multi-tenant
  server, no org-wide deployment for now.
- Distribution model: lab-only for the current feature set. Users clone
  the repo into their own CryoCloud session and build the environment
  themselves via `setup/environment.yml` (conda env `gia-modeling-tool`, includes
  Node for the frontend build alongside the Python geoprocessing/API deps).
  No CryoCloud/2i2c admin coordination needed at this stage. Revisit an
  org-wide shared-image submission (PR to CryoInTheCloud/hub-image) only
  if the tool grows beyond single-lab use.
- Exposure mechanism: `jupyter-server-proxy`, running the FastAPI app
  inside the user's own pod, sharing their filesystem directly.
- **FastAPI serves the built frontend as static files** (`frontend/dist`
  via `StaticFiles`), so there's one process/port to proxy, not two. Vite
  dev server is for local hot-reload only, proxying `/api` to a local
  FastAPI instance — irrelevant to the CryoCloud deployment path.
- **Routing is relative everywhere** — no leading-slash paths anywhere in
  the frontend (see `frontend/src/api/client.js` comments). Required
  because `jupyter-server-proxy` serves the app under a per-user path
  prefix (`/user/<name>/proxy/<port>/...`) not knowable at build time.

## Key design decisions
- CRS handling lives entirely in the API layer (`api/crs.py`), never in
  `backend/main.py`/`backend/app.py`.
- Origin coordinate input supports three explicit modes (match_raster,
  decimal_degrees, epsg) rather than one ambiguous format — see
  `documentation/api-README.md`.
- A 500m geodesic distance check (via pyproj.Geod) guards against CRS mismatches
  regardless of which origin mode is used.
- Non-geographic input rasters are reprojected to EPSG:4326 server-side before
  processing, since calculate_tilt() requires geographic degrees.
- Temp storage is job-scoped, under a configurable GIA_STORAGE_DIR env var
  (defaults to OS temp dir) — environment-agnostic re: eventual CryoCloud hosting.
- File input is dual: drag-and-drop upload and a typed server-side path are
  both first-class (path input works because the API shares the user's own
  pod filesystem). Neither can be validated purely client-side — a typed
  path has no client-accessible bytes at all, and even drag-and-drop
  shouldn't re-implement validation logic separately from the backend's
  `raster_io_check` — so both route through one shared preflight call
  (`POST /api/preflight`).
- Map visualization panel (`frontend/src/components/map/MapPanel.jsx`) is an
  intentionally dumb, pipeline-agnostic component — it never calls into
  geoprocessing logic, just renders whatever `{extent, rasterPreview,
  origin, azimuthLine, contour, tiltedRasterPreview}` shape it's handed
  (vanilla Leaflet, no `react-leaflet`). Input-preview (extent from
  `/api/preflight`, raster from `/api/raster-preview`, origin from
  `/api/resolve-point`, azimuth line computed client-side) and
  result-preview (contour/tilted raster, populated from `/api/process`'s
  response only after a real run) are two separate adapter steps in
  `App.jsx` feeding one renderer, not one that assumes it can show
  everything from day one. See `documentation/GIA_Tool_Penpot_Spec.md` and
  `documentation/VISUALIZATION_PIPELINE_SPEC.md` for the full contract and
  rationale.
- `/api/process`'s response is a zip bundle (`.gpkg` + `contour.geojson` +
  optional `preview_tilted.tif`), not a bare `.gpkg` — see
  `documentation/api-README.md`. The two preview artifacts are read back
  from the just-written `.gpkg` (`gpd.read_file` for the vector layer,
  `rasterio` against the GPKG raster table for the DEM) rather than
  threaded out of `backend/app.py::process_dem`'s internals — deliberately,
  to keep `backend/app.py`/`backend/main.py` at zero diff per the entry
  above, at the cost of one cheap extra read of already-computed,
  already-small output (not a second pipeline run).
- Target elevation is DEM-authoritative: when the origin falls inside the
  DEM on valid data, the DEM's own elevation there overrides any submitted
  `target_elevation` (the tilt plane pivots through the origin, so the two
  must agree for the contour to pass through it). Manual entry only applies
  outside the DEM's bounds or on nodata cells. Enforced server-side in
  `/api/process`; `/api/origin-elevation` is a preview-only convenience, not
  a second source of truth.

## Open items
- Sync vs. async processing for very large DEMs — currently synchronous
  (threadpool-backed), not yet needing a job-queue/polling pattern. The
  frontend's loading state is deliberately indeterminate to match this.
- No auth/rate-limiting yet.
- `PREVIEW_MAX_DIM` (in `api/raster_preview.py`, currently 1024px) is a
  starting value, not yet tuned against real DEM sizes/memory behavior in
  an actual CryoCloud pod — revisit alongside the next-milestone testing
  below. If decimated raster previews turn out to be a real problem there,
  the fallback is a non-georeferenced flat colorized PNG instead (drops
  `georaster`/`georaster-layer-for-leaflet` for that one panel only,
  everything else — extent, origin, azimuth line, contour — is unaffected).
  See `documentation/VISUALIZATION_PIPELINE_SPEC.md`'s "Fallback plan" for
  the full case.
- Possible future: `origin_value`/file-path fields accepting `s3://` URIs
  (CryoCloud's scratch bucket) in addition to local filesystem paths, since
  large DEMs may not fit the ~10GB per-user home directory quota.

## Workflow notes
- `api/smoke_test.py` is a standalone verification script (not part of pytest),
  run with `python api/smoke_test.py` from repo root.
- Run the test suite with `pytest -c setup/pytest.ini --rootdir=.` from the
  repo root, not bare `pytest` — `pytest.ini` living in `setup/` means it
  won't be auto-discovered otherwise (pytest only searches upward from cwd
  for ini files, never into subdirectories), and `--rootdir=.` keeps
  `pytest.ini`'s `pythonpath = .` resolving to the repo root rather than to
  `setup/` itself (which is where rootdir would otherwise default to,
  since that's the ini file's own directory).
- Frontend: wireframed in Penpot against `documentation/api-README.md`'s
  contract; full wireframe rationale and component contracts are in
  `documentation/GIA_Tool_Penpot_Spec.md`. Scaffold exists in `frontend/`
  (React/Vite) — see `documentation/frontend-README.md` for what's
  implemented vs. stubbed.
- Frontend + API + backend are wired end-to-end (including preflight,
  origin-elevation, target-elevation override, and the full visualization
  pipeline — input preview, raster preview, and result preview, per
  `documentation/VISUALIZATION_PIPELINE_SPEC.md`) and covered by tests against synthetic
  fixtures. Not yet validated against real GeoTIFFs and tilt data in an
  actual CryoCloud pod — that's the next milestone (see `PREVIEW_MAX_DIM`
  under Open items).
- This dev machine has no conda installed (`setup/environment.yml` assumes
  one); Python deps are installed via plain `pip` (`setup/requirements-dev.txt`
  + `setup/requirements-api.txt`) into the system Python instead.
  One pre-existing test failure
  (`test_windowed_branch_writes_both_layers_when_include_dem_true`) is a
  numpy-version mismatch from that setup, not a code regression — see that
  test's own comments before assuming a new failure there is your fault.
