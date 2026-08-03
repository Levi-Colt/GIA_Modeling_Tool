# GIA Modeling Tool — Project Context

## Architecture
- `app.py` / `main.py`: backend geoprocessing pipeline (untouched by the API layer,
  keeps its existing test suite intact). Entry point: `app.py::process_dem()`.
- `api/`: FastAPI layer wrapping the backend. Single endpoint: `POST /process`.
  See `api/README.md` for the full request/response contract.
- `frontend/`: React (JS, not TS) + Vite + Tailwind. See `frontend/README.md`
  for structure and what's implemented vs. stubbed.

## Hosting/deployment (decided)
- Target environment: CryoCloud (NASA/2i2c JupyterHub). Each user gets an
  isolated pod with private persistent storage — no shared multi-tenant
  server, no org-wide deployment for now.
- Distribution model: lab-only for the current feature set. Users clone
  the repo into their own CryoCloud session and build the environment
  themselves (`environment.yml`, not yet added — see Open items). No
  CryoCloud/2i2c admin coordination needed at this stage. Revisit an
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
- CRS handling lives entirely in the API layer (`api/crs.py`), never in main.py/app.py.
- Origin coordinate input supports three explicit modes (match_raster,
  decimal_degrees, epsg) rather than one ambiguous format — see api/README.md.
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
  (see Open items: this endpoint doesn't exist yet).
- Map visualization panel is an intentionally dumb, pipeline-agnostic
  component — it never calls into geoprocessing logic, just renders
  whatever `{extent, origin, azimuthLine, contour?, tiltedRasterUrl?}`
  shape it's handed. Input-preview (extent/origin/azimuth, drawable
  client-side from form state) and result-preview (contour/tilted raster,
  only available after a real `/process` run) are treated as two separate
  future states, not one that assumes it can show everything from day one.
  See `GIA_Tool_Penpot_Spec.md` for the full contract and rationale.

## Open items
- **`/api/preflight` endpoint doesn't exist yet.** New scope, not in
  `api/README.md`. Should wrap the existing `raster_io_check` (cheap —
  metadata-only, no full raster load) behind a fast route hit on file drop
  or path entry/blur. The frontend scaffold already assumes this endpoint
  exists (`frontend/src/api/client.js`) — this is the piece that connects
  the two sides.
- No `environment.yml` yet for the CryoCloud per-user env (needed for the
  clone-and-deploy distribution model).
- Sync vs. async processing for very large DEMs — currently synchronous
  (threadpool-backed), not yet needing a job-queue/polling pattern. The
  frontend's loading state is deliberately indeterminate to match this.
- No auth/rate-limiting yet.
- Visualization pipeline (map panel) is a real future feature, not a
  nice-to-have, but genuinely out of scope for the current build — needs
  its own architecture pass (client-side geometry for input-preview,
  in-browser GeoTIFF rendering via `georaster-layer-for-leaflet` for
  result-preview, and how result data crosses from `/process`'s response
  into the map component). Currently a placeholder in the frontend.
- Possible future: `origin_value`/file-path fields accepting `s3://` URIs
  (CryoCloud's scratch bucket) in addition to local filesystem paths, since
  large DEMs may not fit the ~10GB per-user home directory quota.

## Workflow notes
- `api/smoke_test.py` is a standalone verification script (not part of pytest),
  run with `python api/smoke_test.py` from repo root.
- Frontend: wireframed in Penpot against `api/README.md`'s contract; full
  wireframe rationale and component contracts are in
  `GIA_Tool_Penpot_Spec.md`. Scaffold exists in `frontend/` (React/Vite) —
  see `frontend/README.md` for what's implemented vs. stubbed.
- Immediate next milestone: wire frontend + API + backend end-to-end
  (including the new preflight endpoint) for a first usable version to
  test against real GeoTIFFs and tilt data in a CryoCloud pod. Map
  visualization intentionally deferred past this milestone.
