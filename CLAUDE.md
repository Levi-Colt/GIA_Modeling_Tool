# GIA Modeling Tool — Project Context

## Architecture
- `backend/` (`app.py` / `main.py`): backend geoprocessing pipeline
  (the API layer wraps it without reaching into its internals; its existing
  test suite stays intact). The backend is no longer kept at zero diff: it
  changes when a feature genuinely belongs there, with new behavior behind
  defaulted keyword arguments so the basic path stays identical (e.g.
  `process_dem`'s `selection_radius_km`).
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
- `calculate_tilt()` uses a locally-calibrated flat-plane approximation, not a
  per-pixel `pyproj.Geod.inv()` ellipsoidal solve — the earlier per-pixel
  approach built 7-8 full-size float64 coordinate/distance arrays and was the
  real cause of a 13-minute run on a real ~11k×11k DEM that should've taken
  under a minute (`raster_io_check`'s memory estimate never accounted for it).
  Below `RECALIBRATION_THRESHOLD_KM` (100km) it's a single calibration point
  at the tilt origin; above it, a per-row latitude-cosine correction (not the
  literal concentric-distance-band scheme originally proposed — that was
  implemented and measured first, and didn't reduce error at any band width,
  because the real error driver is latitude, not radial distance from the
  origin). `calculate_tilt` also chunks internally in row-strips
  (`chunk_rows`) so its own intermediate arrays stay bounded regardless of
  raster size, independent of `tilt_DEM_windowed`'s block-level windowing.
  Both `chunk_rows` and the three windowed pipeline functions' `tile_size`
  are sized once per run by `largest_safe_tile_size()`, called from
  `process_dem`, rather than each hardcoding its own constant. See
  `documentation/PERFORMANCE_OPTIMIZATION_SPEC.md` for the full diagnosis and
  the measured numbers behind these choices — treat that doc as background,
  not a live spec (it stayed at zero diff during implementation; catch any
  future drift against the code by reading the code, not the doc).
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
  origin, azimuthLine, contour, tiltedRasterPreview, selectionRadius}` shape it's handed
  (vanilla Leaflet, no `react-leaflet`). Input-preview (extent from
  `/api/preflight`, raster from `/api/raster-preview`, origin from
  `/api/resolve-point`, azimuth line computed client-side) and
  result-preview (contour/tilted raster, populated from `/api/process`'s
  response only after a real run) are two separate adapter steps in
  `App.jsx` feeding one renderer, not one that assumes it can show
  everything from day one. See `documentation/GIA_Tool_Penpot_Spec.md` and
  `documentation/VISUALIZATION_PIPELINE_SPEC.md` for the full contract and
  rationale. It draws a basemap (USGS Topo or NRCan Canada Base Map) in its
  own Leaflet `basemap` pane below the raster; `utils/basemap.js` owns the
  external tile URLs, which are absolute on purpose (fetched by the user's
  browser, so the relative-routing rule doesn't apply). The basemap is
  auto-picked once per new DEM extent (center inside the bundled US boundary
  -> USGS, else NRCan); once the user picks one in the layer control, their
  choice wins for the rest of the session. Sizing: it fills whatever cell
  `AppLayout` gives it (`relative h-full w-full`, no fixed pixel height or
  `sticky`) — two thirds of the width and the full viewport height on `lg`+,
  `h-[55vh]` stacked above the form below 1024px — and a `ResizeObserver`
  (rAF-debounced) calls `map.invalidateSize()` so Leaflet never shows gray
  tiles after a resize or the breakpoint switch.
- Basic/Advanced input modes (`documentation/LAYOUT_AND_MODES_SPEC.md`,
  frontend only). `components/shared/AppLayout.jsx` is the one page layout
  for both the form view and the results view (header, form/results column
  with a pinned mode switch + Run footer and a scrolling body, full-height
  map); the mode switch is hidden during a run/results. `StepRail` is
  retired; `utils/steps.js` keeps a four-entry `STEPS` list (upload /
  coordinates / tilt / products → labels DEM / Origin / Tilt / Output) used
  for error routing and `ResultsError`'s "Back to..." label. `BasicForm`
  is a single page of four numbered sections; `AdvancedForm` is the same
  four sections as `CollapsibleSection`s (status line: check + summary, or
  "Needs: ..." from `getReadiness`; body mounted only when open except the
  DEM section, which is `keepMounted` so an in-flight preflight/uncontrolled
  path input survives collapsing). Both forms use the same `step-*` element
  ids, so `classifyErrorStep` (now in `utils/steps.js`) is mode-agnostic; the
  elevation-range error routes to `coordinates` because target elevation
  lives in the Origin section. State rule (`ProcessingContext`): fields
  both modes use stay at the top level under their existing names —
  **`tiltAzimuth` is Advanced's "single azimuth" and `tiltFactor` is
  Advanced's "gradient at origin"; later specs must reuse those keys, never
  add duplicates.** Advanced-only fields live in `formState.advanced`
  (`sectionsOpen` now; profile family/vectors/shore points later), changed
  via `updateAdvanced(patch)` (shallow merge — pass a whole nested object).
  **Switching modes changes only `mode` and never clears or rewrites any
  other field.** `mode` and `advanced` persist through the carry-forward
  mechanism (deep-merged over defaults on load so keys added later get
  defaults from older saves; `localStorage.setItem` is try/catch'd — one
  `console.warn`, in-memory state unaffected); transient advanced state added
  by later specs must be added to `TRANSIENT_KEYS` in `ProcessingContext.jsx`.
  `getReadiness` returns `{ ready, missing: [{section, text}], missingText }`
  (`missingText` feeds the footer's "Still needed" line; `section` is
  `dem | origin | tilt | output`) and `buildProcessPayload` branches on
  `mode`; both have a marked `mode === 'advanced'` branch for later specs
  to append to, and advanced-only fields must never affect a Basic run's
  readiness or payload. **`TiltModelBody`** (in `AdvancedForm.jsx`) is the
  single extension point for the tilt-model section: later specs mount the
  direction-source switch, profile families, vectors, and shore points
  there. `focusRequest` (`{ id, n }`, in `ProcessingPage`) is how error
  routing reaches the forms: Basic scrolls, Advanced opens the section
  first and then scrolls; it is cleared on mode switches.
- Optional selection radius: `select_contours_within_radius` (`backend/main.py`)
  keeps only contours within N km (geodesic) of the origin, applied in
  `process_dem` after the vertex-count filter/simplify. Only the keep-whole
  ("intersects") mode is exposed via the API/UI; the backend's `"clip"` mode
  is a held-back fallback. `X-Selection-Summary` reports the kept count.
- `/api/process`'s response is a zip bundle (`.gpkg` + `contour.geojson` +
  optional `preview_tilted.tif`), not a bare `.gpkg` — see
  `documentation/api-README.md`. The two preview artifacts are read back
  from the just-written `.gpkg` (`gpd.read_file` for the vector layer,
  `rasterio` against the GPKG raster table for the DEM) rather than
  threaded out of `backend/app.py::process_dem`'s internals — deliberately,
  to keep `process_dem`'s return value unchanged, at the cost of one cheap extra read of already-computed,
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
- `RECALIBRATION_THRESHOLD_KM` (100km, in `backend/main.py`) and the
  per-pixel memory-cost constants `largest_safe_tile_size` is called with
  (`TILT_BYTES_PER_PIXEL` / `CONTOUR_BYTES_PER_PIXEL` / `GPKG_WRITE_BYTES_PER_PIXEL`
  in `backend/app.py`) are first-pass estimates, not yet profiled against a
  real large DEM in this environment — see the "Not yet re-validated" /
  "Estimated from... not yet profiled" notes right next to each. Revisit
  alongside the CryoCloud real-data testing milestone below.
- `ensure_wgs84_raster` still requires the input CRS to be *exactly*
  EPSG:4326 — relaxing it to treat any unprojected geographic CRS (e.g.
  NAD83) as close enough, skipping reprojection, was proposed and explicitly
  declined; don't relax this without asking again.
- Contour cleanup (`MIN_CONTOUR_VERTICES` / `CONTOUR_SIMPLIFY_TOLERANCE_DEG`
  in `backend/app.py`) uses conservative first-pass defaults, not tuned
  against a real large contour set.
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
