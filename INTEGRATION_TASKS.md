# Integration Tasks — First Testable End-to-End Version

Goal for this pass: a working round-trip — upload or reference a GeoTIFF,
enter real tilt parameters, run the pipeline, download the `.gpkg` — running
inside a CryoCloud pod via `jupyter-server-proxy`. Map visualization stays a
placeholder (unchanged). Presets and the reprojection modal are out of scope
for this pass too — not started.

This doc assumes the reader has `CLAUDE.md`, `api/README.md`, and
`GIA_Tool_Penpot_Spec.md` open for contract details already established
there. It only specifies what's *new* or *changing*.

Work through tasks in order — later tasks depend on earlier ones (frontend
wiring assumes the API contracts from Tasks 1–2 exist).

---

## Task 1 — `POST /api/preflight`

New route in `api/main.py`, alongside `/process`. Reuses `raster_io_check`
and `check_available_ram_mb` from `main.py` (import them the same way
`api/main.py` already imports `process_dem` from `app.py` — via the
sys.path fixup at the top of the file) and `get_raster_crs` from
`api/crs.py` (already imported there for `/process`).

**Request** — multipart form, exactly one of:
- `dem_file`: file upload
- `file_path`: string, server-side path (same pod filesystem)

Both present or both absent → `422`, detail: `"Provide exactly one of dem_file or file_path."`

**Behavior:**
1. Determine the extension from whichever field was provided
   (`dem_file.filename` or `file_path`). Not in `{".tif", ".tiff"}` → `422`,
   same message pattern as `/process`.
2. **If `dem_file`:** create a job workspace (`create_job_workspace`),
   schedule its cleanup as a `BackgroundTask` (same pattern as `/process`),
   stream the upload to `{job_dir}/input{ext}` with the same
   `MAX_UPLOAD_BYTES` cap → `413` if exceeded. This is the only path that
   needs a job workspace at all — see step 3.
3. **If `file_path`:** no job workspace, no copy. Check
   `os.path.isfile(file_path)` → `400` if not found, detail:
   `f"Could not find a file at '{file_path}'."` Use the path directly as
   the input to step 4.
4. Call `check_available_ram_mb()` then `raster_io_check(input_path, free_ram)`.
   Also call `get_raster_crs(input_path)`. Catch the same exceptions
   `/process` catches from this call path (`FileNotFoundError` → `400`,
   `IOError`/`rasterio` corruption → `400`).
5. On success, return JSON:
   ```json
   {
     "crs": "EPSG:32612",
     "band_count": 1,
     "use_windowed_io": false,
     "needs_casting": false,
     "peak_ram_mb": 812.4
   }
   ```
   (`client.js`'s `UploadStep.jsx` currently only reads `.crs` — the rest
   is there for when the results/loading screens want to say something
   smarter than "Checking..." for large files, e.g. anticipating the
   windowed pipeline. Not required to use it yet.)

**Do not** run reprojection, origin resolution, or the geoprocessing
pipeline here — preflight is metadata-only, matching `raster_io_check`'s
own cost profile. That's the whole point of it existing as a separate,
cheap, fire-on-blur/fire-on-drop route.

---

## Task 2 — `POST /process`: accept `file_path` as an alternative to `dem_file`

Currently `/process` requires `dem_file` as a multipart upload — there's no
way to run it against a typed server path, even though `UploadStep.jsx`
and `CLAUDE.md` both treat typed paths as first-class input. Fix:

- Change `dem_file: UploadFile = File(...)` to `dem_file: UploadFile | None = File(None)`.
- Add `file_path: str | None = Form(None)`.
- Validation, same rule as Task 1: exactly one of the two provided, else `422`.
- Extension check runs against whichever was provided.
- **If `dem_file`:** unchanged — existing streaming-to-`job_dir/input{ext}` logic.
- **If `file_path`:** skip the upload loop and the `MAX_UPLOAD_BYTES` check
  entirely (nothing is being uploaded). Validate `os.path.isfile(file_path)`
  → `400` if missing. Set `input_path = file_path` and proceed into the
  existing origin-resolution / reprojection / processing logic unchanged.

**Important invariant to preserve:** the reprojection step
(`ensure_wgs84_raster`) already writes its output to `job_dir/input_wgs84.tif`
regardless of where the source came from — so a `file_path` source is only
ever *read*, never written to or modified. Don't change that; it's what
makes referencing a path in the user's own pod filesystem safe. `job_dir`
is still created either way, since it's needed for the reprojected
intermediate and the output `.gpkg`.

Everything downstream of input resolution (origin modes, plausibility
check, `process_dem` call, response headers) is unchanged.

---

## Task 3 — Fix the error-contract mismatch in `client.js`

`api/main.py` raises `HTTPException(status_code=..., detail="...")`, which
FastAPI serializes as `{"detail": "..."}`. But
`frontend/src/api/client.js` reads `detail.message` in both `runPreflight`
and `runProcess` — currently always `undefined`, so every error path shows
a generic fallback string instead of the real backend message (e.g. the
500m-threshold or elevation-range errors the Penpot spec explicitly wants
surfaced verbatim).

Fix: in both functions, change `detail.message` → `detail.detail`. Keep
the existing fallback strings (`'Preflight check failed'` /
`'Processing failed'`) for the case where the body isn't JSON at all
(network failure, etc.).

---

## Task 4 — Wire the "Run model" button end-to-end

Currently `App.jsx` renders a `Run model` button with no `onClick`. Add
run/result state and wire it. This state is transient (not carried
forward to `localStorage` like `formState`), so keep it as local state in
`App.jsx` rather than adding it to `ProcessingContext`.

**State shape:**
```js
{
  status: 'idle' | 'running' | 'success' | 'error',
  startedAt: number | null,      // Date.now() when the run started, for the elapsed timer
  result: { blob, filename, reprojectedFrom, warnings } | null,
  error: { message: string, stepId: string | null } | null
}
```

**On click:**
1. Basic client-side completeness guard before calling the API at all —
   `preflightStatus === 'valid'`, `originValue` non-empty, `originEpsg`
   non-empty if `originMode === 'epsg'`, `tiltAzimuth`/`tiltFactor`/
   `targetElevation` all non-empty. If incomplete, don't submit — this is
   a UX nicety, not a substitute for the backend's own `422` validation.
2. Build the payload for `runProcess`:
   ```js
   {
     ...(formState.demFile ? { dem_file: formState.demFile } : { file_path: formState.demPath }),
     origin_mode: formState.originMode,
     origin_value: formState.originValue,
     ...(formState.originMode === 'epsg' ? { origin_epsg: formState.originEpsg } : {}),
     tilt_azimuth: formState.tiltAzimuth,
     tilt_factor: formState.tiltFactor,
     target_elevation: formState.targetElevation,
     include_dem: formState.includeDem
   }
   ```
3. Set `status: 'running'`, `startedAt: Date.now()`.
4. On success: `status: 'success'`, `result: { blob, filename: 'strandlines.gpkg', reprojectedFrom, warnings }`.
5. On failure: `status: 'error'`, `error: { message: err.message, stepId: classifyErrorStep(err.message) }`.

**`classifyErrorStep(message)`** — best-effort keyword heuristic, since the
backend returns free-text `detail` strings, not typed error codes. Not
guaranteed precise; that's an acceptable tradeoff for a routing hint, not
a correctness-critical path.
- Contains "extent", "origin", "500", "geodesic" → `'coordinates'`
- Contains "elevation range" → `'tilt'`
- Contains "file type", "corrupted", "GeoTIFF", "extension" → `'upload'`
- Otherwise → `null` (render a generic "Adjust inputs" action instead of a named-step button)

---

## Task 5 — New components for loading/results screens

Per `GIA_Tool_Penpot_Spec.md`'s "Loading state" and "Results — success/error"
sections. These replace the form+map panel content while `runState.status`
is `'running'`, `'success'`, or `'error'` (screen-level swap, not an inline
addition below the button — matches the Penpot spec treating these as
distinct screens).

- **`frontend/src/components/shared/Banner.jsx`** — variants `info` /
  `warning` / `danger`. Props: `variant`, `children`.
- **`frontend/src/components/results/LoadingState.jsx`** — indeterminate
  spinner, elapsed timer (interval off `runState.startedAt`), fixed copy:
  "Large DEMs can take several minutes. You can leave this page open."
- **`frontend/src/components/results/ResultsSuccess.jsx`** — success
  icon + "Model run complete.", `Banner variant="info"` for
  `reprojectedFrom` (only if present), `Banner variant="warning"` for
  `warnings` (only if present), download card (filename, short contents
  description, `Download` button — build an object URL from the blob,
  trigger via a temporary `<a download>`), a recap line of azimuth/tilt/
  target elevation from `formState`, and two actions: "Run again with
  same inputs" (re-run the same payload) and "Adjust inputs" (reset
  `runState` to idle).
- **`frontend/src/components/results/ResultsError.jsx`** — danger banner
  with `error.message` verbatim, then a button: if `error.stepId` is set,
  "Back to step N · {label}" that resets `runState` to idle and scrolls to
  that step (reuse the `scrollToStep` pattern from `StepRail.jsx` — consider
  lifting it to a small shared util if both need it); otherwise a generic
  "Adjust inputs" button that just resets `runState`.

---

## Task 6 — Serve `frontend/dist` from FastAPI

Add to the **end** of `api/main.py`, after every route decorator
(`/process`, `/preflight`, `/health`) — mount order matters in Starlette,
and a root mount registered first would shadow the API routes:

```python
from fastapi.staticfiles import StaticFiles

_frontend_dist = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "frontend", "dist",
)
if os.path.isdir(_frontend_dist):
    app.mount("/", StaticFiles(directory=_frontend_dist, html=True), name="frontend")
```

The `isdir` guard means `uvicorn api.main:app --reload` still works before
`npm run build` has been run — it just won't serve anything at `/` yet,
which is fine for API-only local development.

---

## Task 7 — `environment.yml` for CryoCloud

New file at repo root. Conda env for the clone-and-build distribution
model described in `CLAUDE.md`. Contents driven directly by
`requirements-api.txt` (which already pulls in `requirements.txt`) plus
Node for the frontend build:

```yaml
name: gia-modeling-tool
channels:
  - conda-forge
dependencies:
  - python=3.11
  - nodejs>=20
  - pip
  - pip:
      - numpy
      - rasterio
      - shapely
      - scikit-image
      - geopandas
      - psutil
      - pyproj
      - fastapi>=0.110
      - uvicorn[standard]>=0.29
      - python-multipart>=0.0.9
```

(`scikit-image` is in `requirements.txt` but doesn't appear referenced in
`app.py`/`main.py`'s current imports as viewed — double check whether it's
still a live dependency or leftover before finalizing this file; not
worth guessing from outside the code.)

---

## Task 8 — CryoCloud run instructions

Add a short "Running in CryoCloud" section to `README.md` (or `CLAUDE.md`,
your call — `README.md` reads more like the right home for run
instructions specifically):

```
conda env create -f environment.yml
conda activate gia-modeling-tool
cd frontend && npm install && npm run build && cd ..
uvicorn api.main:app --host 0.0.0.0 --port <PORT>
```

Then reach it at the pod's `jupyter-server-proxy` URL:
`/user/<your-username>/proxy/<PORT>/`. No 2i2c/CryoCloud admin
registration needed for this — it's a manually-launched proxy target, not
a registered server-proxy extension, matching the "lab-only, no
org-wide deployment" scope `CLAUDE.md` already commits to.

Optionally note `GIA_STORAGE_DIR` can be pointed at persistent pod storage
instead of the OS temp dir if job workspaces should survive a pod restart
(they shouldn't need to for normal operation — everything in one is either
a copy of an input or output already returned to the client).

---

## Explicit non-goals for this pass (unchanged from existing docs)

- Map panel / Leaflet wiring — stays a placeholder.
- Presets bar, reprojection modal — not built.
- `s3://` URI support for `file_path` — not built.
- Auth/rate-limiting — not built.
- Async/job-queue processing for very large DEMs — stays synchronous.

---

## Open decisions I made that you may want to override

- Run state lives in local `App.jsx` state, not `ProcessingContext` — flag
  if you'd rather centralize it.
- `classifyErrorStep`'s keyword list is a first pass, not exhaustive —
  expect to tune it once you see real error strings against real data.
- Loading/results screens fully replace the form panel rather than
  overlaying it — matches the Penpot spec's screen-level framing, but
  worth confirming that's still what you want now that it's concrete.
