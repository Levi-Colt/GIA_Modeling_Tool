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
  `POST /api/origin-elevation`, `POST /api/profile-preview`,
  `POST /api/uplift-preview`, `POST /api/fit-uplift-surface`, `GET /api/health`.
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
- **`vite.config.js` aliases `proj4` to `proj4/dist/proj4-src.js`** (do not remove).
  proj4 2.21 ships its ESM entry with only a `default` export, and
  `proj4-fully-loaded` (a `georaster-layer-for-leaflet` dependency) `require()`s it;
  in a *production* build Rollup's CommonJS interop gave it a function wrapper with
  `.default` but no `.defs`, which its own unwrap check (`typeof === 'object'`)
  misses, so the bundle threw `x.defs is not a function` at load and the built app
  was a blank page (present since before spec 4; `npm run dev` uses esbuild's
  interop and never showed it). Verify a build by loading it through FastAPI in a
  real browser, not just `npm run build` — jsdom/Vitest can't see this class of bug.
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
  origin). That calibrated frame now lives in `_local_en_km` (with its exact
  inverse `_local_en_to_lonlat`), and `_tilt_block` is just `lons, lats` →
  `_local_en_km` → `uplift_model.evaluate(east_km, north_km)` → `block - U`;
  see the uplift-model entry below. `calculate_tilt` also chunks internally in
  row-strips (`chunk_rows`) so its own intermediate arrays stay bounded
  regardless of raster size, independent of `tilt_DEM_windowed`'s block-level
  windowing. Both `chunk_rows` and the three windowed pipeline functions'
  `tile_size` are sized once per run by `largest_safe_tile_size()`, called from
  `process_dem`, rather than each hardcoding its own constant (the tilt cost is
  `TILT_BYTES_PER_PIXEL + uplift_model.extra_bytes_per_pixel`). See
  `documentation/PERFORMANCE_OPTIMIZATION_SPEC.md` for the full diagnosis and
  the measured numbers behind these choices — treat that doc as background,
  not a live spec (it stayed at zero diff during implementation; catch any
  future drift against the code by reading the code, not the doc).
- **Location-agnostic, spillway-anchored (design principle).** The tool is a
  general-purpose model for users who usually *don't* have dense paleo-strandline
  data. Nothing in defaults, UI text, placeholders, help text, warnings, `detail`
  messages, results text or `aria-label`s may be tuned to, or point users
  toward, one paper or one set of basins. Lewis, Breckenridge & Teller (2021)
  informed the model's *form* (polynomial profiles, varying uplift directions);
  it is not a calibration source. Comments and docstrings may cite it as
  background for the form, never its values as defaults or "typical" settings.
  Profile defaults are empty fields and the `origin` hinge; placeholders are
  units only. Enforced for `frontend/src` (non-test) and `api/` by
  `tests/test_no_basin_specific_text.py` (its term list lives in that file);
  test fixtures may use realistic values but must not be named after a basin.
  Everything is described in spillway terms: the strandline is contoured at the
  spillway's DEM elevation, uplift is zero there, and `tilt_factor` is the
  gradient *at the spillway* (user-facing text says "spillway"; code keeps
  "origin"). Future specs (vectors, shore points) inherit this.
- **Uplift models** (`backend/uplift.py`, `documentation/UPLIFT_MODEL_SPEC.md`
  as amended by `documentation/UPLIFT_MODEL_CORRECTIONS_SPEC.md`, "spec 4a";
  where they conflict, 4a wins).
  The tilted DEM is `DEM − U`, where `U` is uplift in meters *relative to the
  origin* and comes from a pluggable model: `evaluate(east_km, north_km) → U`
  (float64, broadcastable), plus `extra_bytes_per_pixel` for the memory
  estimate. `U(origin) == 0` always, which keeps the DEM-authoritative target
  elevation valid. `calculate_tilt` / `tilt_DEM_windowed` / `process_dem` take
  `uplift_model=None`; `None` builds `linear_planar_model(tilt_azimuth,
  tilt_factor)`, and a given model takes precedence (azimuth/factor are then
  ignored by the math). Profiles are `U(d) = Σₖ cₖ dᵏ`, k = 1…n, no constant
  term, `d` = signed km along the azimuth (the pre-clamp
  `projected_distance_km`). **`tilt_factor` is always c₁, the gradient at the
  spillway** — one source of truth in every family (`linear`; `quadratic`,
  c₂ = k/2, whose curvature `k` may be given as a `rate_of_increase` **or** as a
  `second_gradient` {gradient, distance_km} which the API layer converts with
  `k = (gradient − tilt_factor)/distance_km`, so the backend and
  `run_parameters.json` stay canonical in k; `polynomial` with c₂…c₅).
  **Hinge modes** (behind the spillway): `origin` (d_h = 0; **the default for
  every family**), `distance` (−distance_km), `none` (the profile continues to
  the DEM edge; valid for linear too). Evaluation is `U(max(d, d_h))`.
  **The zero-gradient point is a guard, not a hinge mode** (`natural` was
  removed; the API returns a 422 explaining that): in every mode, if g = U′
  reaches zero behind the spillway *before* the mode's point (largest real root
  of g in (mode's point, 0)), uplift is held constant from that zero — uplift
  never re-increases behind the spillway. It is reported as *information*, not
  a warning: `PolynomialProfile.resolve_hinge` returns `(d_h, source)` with
  `source` = `'mode' | 'guard' | None`, exposed as `hinge_source` next to
  `hinge_km` by `/api/profile-preview` and `run_parameters.json`; the frontend
  builds the "gradient reaches zero X km behind the spillway…" note from them.
  `d_h` is resolved **once at model build time** (`numpy.roots`; roots within
  1e-12 of 0 count as "at the origin"), so per-block work is purely elementwise
  and windowed == in-memory. There is no forward guard; a gradient sign change
  within the DEM's up-tilt range only warns, via
  `model.warn_for_range(d_min, d_max)`, called from `process_dem` (a model
  can't know the DEM's extent at build time) with the range from
  `uplift_d_range_km` (the four bounds corners through `_local_en_km`, the same
  helper `/api/profile-preview` uses). **`_local_en_km` is the single shared
  local frame**: isobases, vectors and shore points (specs 5/6) must be built
  in it (and mapped back with `_local_en_to_lonlat`), never in a separately
  derived projection. **The basic path is bit-identical to the pre-refactor
  arithmetic**, asserted with `np.array_equal` (never `allclose`) against a
  frozen `_legacy_tilt_block` in `tests/test_tilt_legacy_regression.py` —
  don't loosen that test to make a change pass; for a single coefficient
  `PolynomialProfile.U` is the literal `d * c1`. The API layer validates the
  `tilt_model` JSON with Pydantic (`api/tilt_model.py`, `extra="forbid"`,
  specific 422 messages; the parse functions take `tilt_factor` because the
  second-gradient conversion needs it) and hands `backend/uplift.py` a plain
  dict — the backend has no Pydantic/FastAPI imports. `POST
  /api/profile-preview` returns the curve with no raster I/O. Every zip also
  carries `run_parameters.json`. Frontend: profile state in `advanced.profile`
  (`curvatureInput: 'secondGradient' | 'rate'`, default `'secondGradient'`; the
  hidden form and hidden polynomial coefficient slots keep their typed values)
  and `advanced.hinge` (`mode: 'origin' | 'distance' | 'none'` — there is **no
  `'default'` value**; the payload always sends an explicit mode, and
  `loadCarriedForwardState` maps a persisted `'default'`/`'natural'` to
  `'origin'`); the numeric text inputs go through `parseFiniteNumber` (rejects
  `''`, unlike `Number('')`); a quadratic sends only its active curvature form;
  the preview response is the **transient top-level `profilePreview` key** (in
  `TRANSIENT_KEYS`), fetched by `useProfilePreview` from `ProcessingPage` so it
  exists while the tilt section is collapsed and feeds the results screen's
  hinge summary. The chart labels its zero line "spillway" and marks the
  second-gradient point (interpolated from the returned samples) while that form
  is active. Spec 5's per-vector custom quadratic must accept the same two
  curvature forms (second gradient relative to the vector's own location).
- **Vector direction fields** (`backend/direction_field.py`,
  `documentation/VECTOR_FIELD_SPEC.md`, spec 5; backend, API and frontend are
  all done — the frontend half is described in the next entry). A
  second `tilt_model.direction.type`, `vectors`: each vector is a location, an
  azimuth (direction of maximum uplift) and an optional **range**. **Range is the
  vector's range of influence (how far its direction is trusted), never a
  magnitude**; magnitude comes from the global profile (`tilt_factor`, profile,
  hinge) or a per-vector **custom tilt** (linear or quadratic only), whose
  **gradient is local — the gradient at that vector's own location** (a custom
  quadratic's second gradient is relative to the vector, `k = (gradient −
  local_gradient)/distance_km`; same two curvature forms as the global profile).
  The method, all in `_local_en_km`'s frame (never a second projection): a working
  grid (≤256 cells on the long side, DEM bounds + 5%); unit directions
  (`Geod.fwd` 1 km mapped into the frame) blended with weights
  `max(exp(−(r/R)²), 1e-6) / (r² + h²)` (default R = median nearest-neighbour
  distance, or 0.5 × frame diagonal for one vector/coincident vectors);
  near-opposite nodes (`|V|/Σw < 0.05`) fall back to the nearest vector and warn
  above 1%; **pass 1** solves least squares for a curved distance coordinate φ
  (`∇φ ≈ v̂`, normal equations factored once with `splu`, anchored φ(origin)=0);
  **Case A** (every vector uses the global profile): `U = profile.U(max(φ, d_h))`;
  **Case B** (any custom tilt): blend per-vector gradients `G_i(φ)` with the same
  weights, apply the hinge in gradient form, then **pass 2** integrates `∇U ≈ G·v̂`
  with the same solver. The model is a `GridUpliftModel` (bilinear sample via
  `scipy.ndimage.map_coordinates`, positions outside the grid clamp). **Deviation
  from the spec, approved:** in Case A the grid holds φ and the profile is applied
  per pixel after sampling (not U sampled from a grid) — exact for a uniform field
  (single-vector regression is ~1e-13 vs a `PlanarUpliftModel` at the azimuth the
  mapped direction implies) and it keeps the hinge kink sharp; Case B samples U.
  **Second approved deviation:** the model is built in `api/main.py`, right after
  reprojection, from the working raster's transform/shape (it needs the raster
  geometry, and `process_dem` already takes `uplift_model=`), so `backend/app.py`
  is unchanged. **Third:** in `vectors` mode with every vector custom the global
  `profile` is optional/ignored (no `tilt_factor` to build c₁ from); the hinge
  still applies (resolved from its mode alone). Diagnostics (per-vector direction
  misfit — angle between ∇φ and v̂ at the vector, `null` outside the grid — RMS,
  max, worst vector, degenerate fraction) come back in `X-Tilt-Model-Diagnostics`,
  `run_parameters.json` `diagnostics`, and `POST /api/uplift-preview` (isobases as
  GeoJSON at 1/2/5×10ⁿ levels, ≤12; the spillway's isobase is contoured from φ,
  not U). Warnings (not errors): near-opposite directions, worst misfit > 15°, a
  vector more than half the DEM diagonal outside its bounds. **Known LS
  behaviour:** two custom gradients at one azimuth aren't curl-free, so Case B's
  `U = 0` contour tilts slightly off φ = 0 and U drifts a little behind the
  spillway — inherent to the spec's least-squares integration, not a bug.
  `tilt_azimuth` / `tilt_factor` are optional form fields with condition-specific
  422 messages (`api/tilt_model.py::require_direction_inputs`; for a basic run,
  both stay required); `/api/profile-preview` (azimuth) and `/api/uplift-preview`
  (vectors) each 422 and point at the other. **Preview vs run (E6):** the preview
  grid comes from preflight `bounds_wgs84` through the same code as a run's, which
  uses the real raster's transform — identical for an EPSG:4326 DEM, negligibly
  different for a reprojected one; if they ever diverge, trust the run.
- **Vector direction fields — frontend** (spec 5). `TiltModelBody` (still the
  one tilt-model extension point) starts with a Direction-source switch, `Single
  azimuth | Vectors | Shore points` (the third is spec 6, next entry). State: `advanced.
  directionSource` and `advanced.vectors` (persisted; every field a string, rows
  have stable `id`s — `utils/vectors.js` owns the row model, readiness
  (`vectorIssues`), the payload (`buildVectorsDirection`), CSV import (papaparse;
  aliases matched case-insensitively; invalid rows skipped whole and reported;
  Replace/Append buttons) and the undo stack). **Selection, add-on-map mode, the
  focus request and `upliftPreview` are transient top-level keys** (in
  `TRANSIENT_KEYS`), not in `advanced` — deviating from the spec's sketch, because
  `TRANSIENT_KEYS` only excludes top-level keys. `usingVectors(formState)`
  (`utils/tiltModel.js`) = Advanced + vectors source; Basic never is. In vectors
  mode: no `tiltAzimuth` requirement/payload field, `tiltFactor` required (and sent)
  only while some vector is global, the global profile's fields count only while
  some vector is global (the hinge always does), and the profile is omitted from
  `tilt_model` when every vector is custom. `useUpliftPreview` (debounced 500 ms;
  needs a ready tilt section + resolved origin + DEM bounds) keeps
  `formState.upliftPreview` current; `useProfilePreview` is azimuth-only. Table:
  #, Lat, Lon, Azim °, Range km, Tilt, Fit ° (amber above 15°), remove;
  custom rows expand below (family, **local** gradient, and for a quadratic the
  same Curvature-from control as the global profile, second gradient relative to
  the vector). **`MapPanel`'s editing contract** (`editing` prop: `mode`,
  `onAddVector`, `onUpdateVector`, `onSelectVector`, `onExitAddMode`; `mapData`
  gains `vectors` and `isobases`) — **still no geoprocessing**: it renders what it
  is given and reports geometry edits, once, on drag end; bearing/distance/arrow
  math is `utils/geometry.js` (turf); the gestures are `components/map/
  VectorLayer.js`. `MapPanel` now has one pane and one effect per layer group (so
  editing vectors doesn't rebuild the raster) and refits only when the contour,
  raster base or extent changes; `App.jsx` memoizes each `mapData` field for that.
  Layer order: raster → selection radius → isobases → contour → vectors → azimuth
  line (azimuth source only) → origin (spec 6 inserts the data hull below the
  isobases and the shore points above the vectors; see the next entry). Range is
  influence, not magnitude, and custom gradients are local — in every label and
  help text.
- **Shore-point uplift surfaces** (`backend/uplift_surface.py`,
  `documentation/SHORE_POINT_SURFACE_SPEC.md`, spec 6; backend, API and frontend
  are all done). A third `tilt_model.direction.type`, `points`: users with
  shoreline elevation data fit the deformed water plane directly instead of
  describing it with directions and profiles. **The fit is a polynomial trend
  surface of order 1, 2 or 3 (least squares in the (e/L, n/L) basis, constant term
  included), not an exact interpolating spline** — shoreline elevations scatter,
  and an exact fit would chase that noise. **Magnitude comes from the data**: no
  profile family, no `tilt_factor`; the API rejects a top-level `profile`/`hinge`
  in this mode (422), and neither `tilt_azimuth` nor `tilt_factor` is required.
  All of it is in `_local_en_km`'s frame with the run's own `diagonal_km`.
  **`U = S(e, n) − S(origin)`** (`U(origin) == 0`, so the DEM-authoritative target
  elevation holds), the tilted DEM is `DEM − U`, and `S` is evaluated analytically
  per pixel (`SurfaceUpliftModel`, grouped by n-power so a separable input stays
  cheap). **The isobases the user sees are contours of `S`** (absolute meters
  a.s.l.); the model itself uses `U` — don't conflate them (spec 5's isobases are
  relative uplift). Defaults: **hinge `none`** (U as fitted on both sides of the
  spillway; `origin` clamps `U ≥ 0`) and **extrapolation `warn`** (`mask` NaNs the
  tilted DEM outside the hull). Hull = convex hull of the points buffered by
  `HULL_BUFFER_FRACTION` (10% of its diameter; first-pass, untuned), rasterized on
  a **1024-cell grid** (`HULL_MASK_CELLS`) — finer than spec 5's 256-cell working
  grid, so a masked edge isn't visibly stair-stepped; the same grid gives
  `dem_fraction_outside_hull`; `warn` mode warns above 20%. Minimum points =
  terms + 3 (6, 9, 13); a near-collinear/clustered set (cond > 1e8) warns; so does
  the origin lying outside the hull (an addition to the spec: `U(origin) = 0` holds
  by construction but `S` is extrapolated there). Standardized residuals are
  `r / sqrt(SSE/dof)`, flagged beyond ±3 and **never auto-removed** (with few
  degrees of freedom |r/s| can't reach 3, so flagging mostly matters for larger
  sets). `POST /api/fit-uplift-surface` returns every feasible order's statistics
  (the UI's advisory comparison table), the selected order's residuals, isobases
  split `inside`/`outside` the hull (dashed on the map; `outside` is always empty
  in `mask`), the hull polygon and warnings — no raster I/O, same "trust the run"
  preview-vs-run caveat as spec 5. `/api/process` adds `X-Tilt-Model-Diagnostics`
  (order, R², RMSE, outside fraction), the full fit statistics and coefficients in
  `run_parameters.json` `diagnostics`, and **`shore_points.csv` in the zip** (lat,
  lon, elevation_m, label, residual_m — re-importable) so the bundle alone
  reproduces the run. **Approved deviations from the spec:** (1) the model is built
  in `api/main.py` after reprojection (as spec 5), not in `backend/app.py`; (2) the
  hull mask grid is 1024 cells (above); (3) two small spec-5 helpers were extracted
  with identical behaviour — `working_grid` and `contour_lines_frame`/
  `contour_lines_lonlat` in `backend/direction_field.py` — and the surface's own
  isobase function lives in `uplift_surface.py`; (4) the origin-outside-hull
  warning; (5) shore-point rows carry a stable `id` and string fields (like
  vectors). **`extract_strandline_contours` does NOT exclude NaN regions** (the
  spec assumed it did): the contour tracing a valid/NaN boundary sits ~0.0002 px
  inside the valid side, rounds onto a valid cell and slips past the whole-line
  NaN check, and a real strandline reaching that boundary is one polyline with it.
  So `extract_strandline_contours[_windowed]` take **`trim_nan_edges`** (drop every
  vertex with a NaN among its four surrounding cells and split the line there),
  which is **on by default, for every run** (decided after spec 6: it also removes
  the same spurious edge line next to real nodata borders in ordinary DEMs, and a
  strandline that touches a nodata cell is now kept minus the touched part instead of
  dropped whole). `trim_nan_edges=False` is the pre-spec-6 behaviour, kept for
  comparison/tests. This is the one place the basic path's *contours* deliberately
  differ from before spec 6 (only for DEMs with nodata); the tilt arithmetic is
  unchanged. Frontend: `advanced.shorePoints` (rows `{ id, lat, lon,
  elevationM, label }`, all strings) and `advanced.surface` (`{ order: 2, hinge:
  'none', extrapolation: 'warn' }`) are persisted (a localStorage quota failure
  only costs the carry-forward); **the fit response is the transient top-level
  `surfaceFit` key** (in `TRANSIENT_KEYS`), stored as `{ status, data, error, key }`
  where `key` is the request it answers — residuals and colors are used only when
  `key` matches the current request (`surfaceFitKey`), while the isobases and hull
  keep showing the last data while a refit is pending. `useSurfaceFit` (debounced
  500 ms; stale responses dropped) mirrors `useUpliftPreview`. `usingPoints(formState)`
  = Advanced + points source. Readiness (keyed to `tilt`): at least the minimum for
  the chosen order and every point valid; the payload sends neither `tilt_azimuth`
  nor `tilt_factor` and `tilt_model` has no `profile`/`hinge` (`label` only when
  present). `utils/shorePoints.js` owns the row model, readiness, payload, CSV
  parsing (`parseShorePointsCsv(text, mapping?)`: header aliases, then a column
  picker over the file's own headers — columns addressed by index, so duplicate or
  blank headers work) and the map adapter; `components/advanced/CsvImport.jsx` is now
  the schema-agnostic `CsvImportPanel` (the vectors import is a thin wrapper);
  `ShorePointsPanel.jsx` (in `TiltModelBody`, which hides the profile/hinge blocks
  and shows "Magnitude comes from the fitted surface.") holds the order control
  (infeasible orders disabled with a tooltip), comparison table, options and the
  editable/sortable table. `MapPanel`'s `mapData` gains `shorePoints` (circles
  colored blue↔orange by residual via `utils/colors.js`; outliers ringed, drawn
  last; tooltips are DOM text, never HTML — a label is user data), `surfaceIsobases`
  (`{ inside, outside }`, absolute-meter labels) and `dataHull`, plus a residual
  legend; panes are now radius → hull → isobases → contour → vectors → points →
  azimuth → origin; still render-only (no map editing in this mode). Location-
  agnostic rule applies: no UI text or 422 message names a basin.
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
  origin, azimuthLine, contour, tiltedRasterPreview, selectionRadius}` (plus, for the
  vectors and shore-points sources, `vectors`/`isobases` and `shorePoints`/
  `surfaceIsobases`/`dataHull`) shape it's handed
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
  Advanced's "gradient at spillway"; later specs must reuse those keys, never
  add duplicates.** Advanced-only fields live in `formState.advanced`
  (`sectionsOpen`, `profile`, `hinge` now; vectors/shore points later), changed
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
  to append to (it now carries the uplift-model checks / `tilt_model`
  field), and advanced-only fields must never affect a Basic run's
  readiness or payload. **`TiltModelBody`** (now
  `components/advanced/TiltModelBody.jsx`, imported by `AdvancedForm.jsx`) is
  the single extension point for the tilt-model section: it holds the
  profile family / parameters / hinge / chart, and later specs mount the
  direction-source switch, vectors, and shore points there. `focusRequest` (`{ id, n }`, in `ProcessingPage`) is how error
  routing reaches the forms: Basic scrolls, Advanced opens the section
  first and then scrolls; it is cleared on mode switches.
- Optional selection radius: `select_contours_within_radius` (`backend/main.py`)
  keeps only contours within N km (geodesic) of the origin, applied in
  `process_dem` after the vertex-count filter/simplify. Only the keep-whole
  ("intersects") mode is exposed via the API/UI; the backend's `"clip"` mode
  is a held-back fallback. `X-Selection-Summary` reports the kept count.
- `/api/process`'s response is a zip bundle (`.gpkg` + `contour.geojson` +
  optional `preview_tilted.tif` + always `run_parameters.json`), not a bare
  `.gpkg` — see
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
  **Spillway-elevation assumption:** the strandline is contoured at the
  spillway's *present* DEM elevation. This assumes the spillway sill has not
  been significantly eroded, incised, or buried since the shoreline formed, and
  it ignores the depth of water flowing over the sill (typically a few meters).
  Where either is significant, enter the target elevation manually by placing
  the origin off the DEM, or accept that offset. The Origin section shows a
  muted one-line note to this effect under the target-elevation field, in both
  modes.

## Open items
- `HULL_BUFFER_FRACTION` / `HULL_WARN_FRACTION` / `HULL_MASK_CELLS` /
  `EXTRA_BYTES_PER_PIXEL` (in `backend/uplift_surface.py`) are first-pass values,
  not tuned against a real shoreline data set or a large DEM. Revisit with the
  CryoCloud real-data milestone below.
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
  since that's the ini file's own directory). To run one file, use
  `python -m pytest -c setup/pytest.ini --rootdir=. tests/test_x.py`: bare
  `pytest` with a file path fails to import `backend` (the repo root isn't on
  `sys.path` then), while `-k` selection on the full run works.
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
  (It did not reproduce when spec 4 landed: the full suite was green.)
