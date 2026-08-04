# Target Elevation Correctness, GPKG Write Safety, Doc Updates

Three fixes, addressed before the visualization pipeline work starts.
Written against the current state of `api/main.py`/`api/crs.py`/
`api/README.md` post-`INTEGRATION_TASKS.md` — read those files as they
exist now, not as `INTEGRATION_TASKS.md` originally proposed them, since
some details (route prefixes, the `dem_file`/`file_path` duality already
being shared between `/api/process` and `/api/preflight`) evolved during
that implementation pass.

---

## Background: why target_elevation needs this

In `calculate_tilt` (`main.py`), the projected distance — and therefore
the elevation delta — is exactly zero at the tilt origin; the tilt is a
plane pivoting through that point. That means **the tilted DEM's value at
the origin is always identical to the raw modern DEM's value there,
regardless of tilt_azimuth or tilt_factor.** So a user-supplied
`target_elevation` that doesn't match the DEM's actual elevation at the
origin produces a strandline contour that doesn't pass through the origin
at all — which undermines the point of anchoring the tilt there.

Resolution (confirmed): when the origin falls inside the DEM and the
DEM has valid (non-nodata) data there, **the DEM's own value is
authoritative and silently-but-visibly overrides whatever the user typed**
— "silently" in that processing doesn't block or error, "visibly" in that
the response must say so. Manual `target_elevation` is only actually used
when the origin falls outside the DEM's bounds, or lands on a nodata
cell — the two cases where there's nothing to sample.

This must be enforced **server-side, in `/api/process` itself** — not
just as a frontend convenience — since that's the only place with
guaranteed access to the same working raster the pipeline actually tilts.
A frontend preview is still worth building (Task 2) for UX, but it is not
the correctness mechanism.

---

## Task 1 — `sample_elevation_at_point` in `api/crs.py`

New function, same module as the other raster-inspection helpers:

```python
def sample_elevation_at_point(raster_path: str, lon: float, lat: float) -> float | None:
    """
    Samples the raster's band-1 value at (lon, lat), assuming raster_path
    is already in EPSG:4326 (true for both /api/process's working_path
    post-ensure_wgs84_raster, and for a preflight-validated source raster
    when checking a match_raster-mode origin that's already native-CRS
    aligned... no -- see Task 2 note on this).

    Returns None if the point falls outside the raster's pixel grid, or if
    the sampled cell is nodata / NaN. Returns the float value otherwise.
    """
```

Implementation approach: `rasterio.transform.rowcol(src.transform, lon, lat)`
to get pixel row/col, bounds-check against `(src.height, src.width)`,
read a single-pixel window, compare against `src.nodata` (and `np.isnan`,
since `ensure_wgs84_raster`'s bilinear resampling can produce NaN at edge
pixels even where nodata wasn't cleanly aligned).

---

## Task 2 — `POST /api/origin-elevation` (preview endpoint)

New route in `api/main.py`, same file-resolution duality as `/api/preflight`
(exactly one of `dem_file` / `file_path`), plus the same origin fields
`/api/process` takes (`origin_mode`, `origin_value`, `origin_epsg?`).

**Purpose:** lets the frontend show the DEM-sourced elevation (or explain
why it can't) *before* a full run, rather than the user only finding out
after a potentially multi-minute `/api/process` call. This is a UX
convenience — `/api/process` still enforces the same logic authoritatively
regardless of what this endpoint returns or whether the frontend calls it
at all.

**Behavior:**
1. Resolve the input source exactly like `/api/preflight` does (reuse that
   logic if it's easy to factor out into a shared helper — see the
   refactor note at the end of this doc; not required if it adds more risk
   than it's worth right now).
2. Resolve the origin to (lon, lat) in WGS84 exactly like `/api/process`
   does (same `parse_xy_pair` / `parse_decimal_degrees_hemisphere` /
   `normalize_origin_to_wgs84` / `get_raster_crs` call pattern for
   `match_raster` mode).
3. Check bounds via `get_raster_bounds_wgs84` — note this is a **strict
   inside/outside test**, not the 500m plausibility threshold `/api/process`
   applies. A point can be within the 500m threshold and still be
   genuinely outside the raster (that's the whole reason the threshold
   exists at 500m and not 0). Don't reuse `check_origin_within_threshold`
   here; write a direct bounds containment check, or treat "not found by
   `sample_elevation_at_point`" as sufficient (see next step — this may
   make a separate bounds check redundant, since `sample_elevation_at_point`
   already returns `None` for genuinely out-of-grid points).
4. **Important subtlety on which raster to sample against:** `/api/process`
   samples the origin's elevation from `working_path` — the raster *after*
   `ensure_wgs84_raster` reprojection — because that's the array the tilt
   pipeline actually operates on, and consistency with what gets tilted
   matters more than consistency with the original upload. This preview
   endpoint should do the same: call `ensure_wgs84_raster` on the resolved
   input (into a job-scoped temp path) before sampling, not sample the raw
   uploaded/pathed file directly. This does mean the preview endpoint pays
   the reprojection cost too when the source isn't already EPSG:4326 — that
   cost is unavoidable if the preview is to actually match what `/api/process`
   will use; a preview that could disagree with the real run isn't worth
   building. Clean up the job workspace afterward same as the other routes.
5. Return:
   ```json
   { "within_bounds": true, "elevation": 812.4, "reason": null }
   ```
   or
   ```json
   { "within_bounds": false, "elevation": null, "reason": "outside_bounds" }
   ```
   or
   ```json
   { "within_bounds": true, "elevation": null, "reason": "nodata" }
   ```

Error taxonomy matches `/api/preflight` (`422` for input-shape/origin
validation, `400` for missing file / corrupted raster).

---

## Task 3 — `/api/process`: server-side authoritative override

Right after `working_path` is established (post-`ensure_wgs84_raster`,
before the `run_in_threadpool(process_dem, ...)` call), add:

```python
sampled_elevation = sample_elevation_at_point(working_path, origin_lon, origin_lat)
if sampled_elevation is not None:
    effective_target_elevation = sampled_elevation
else:
    effective_target_elevation = target_elevation
```

Pass `effective_target_elevation` (not the raw `target_elevation` form
field) into `process_dem(...)`.

**New response headers**, added alongside the existing
`X-Source-CRS-Reprojected-From` / `X-Processing-Warnings` pattern:

- `X-Target-Elevation-Source`: `"dem"` if `sampled_elevation is not None`,
  else `"manual"`.
- `X-Target-Elevation-Note`: only present when source is `"dem"` **and**
  the user's submitted `target_elevation` differs from `sampled_elevation`
  by more than a small tolerance (e.g. `1e-6` — exact-match cases, which
  will be common when the frontend's preview pre-filled the field, don't
  need a note). Message pattern:
  `"Target elevation was set to {sampled_elevation:.2f} m (from the DEM at "
  "the origin) instead of the entered value of {target_elevation:.2f} m."`

This mirrors the existing header pattern exactly (`api/main.py` already
builds a `headers = {}` dict before the `FileResponse` — add to it, same
place). Update `api/README.md`'s "Errors" section header list and the
`target_elevation` row in "Request fields" to describe this override
behavior — it's part of the contract now, not an implementation detail.

---

## Task 4 — Frontend: target elevation field behavior

In `frontend/src/components/steps/TiltAndProductsSteps.jsx`'s `TiltStep`
(or split `target_elevation` into its own component if that file is
getting crowded — your call), replace the plain number input for
`target_elevation` with state-driven behavior:

- **Trigger:** call the new `originElevation` client function (add to
  `client.js`, same pattern as `runPreflight`) once `preflightStatus ===
  'valid'` **and** the coordinate step's fields are complete (mirrors the
  `UploadStep` on-blur pattern — fire on blur of the coordinates input(s),
  not on every keystroke).
- **Checking:** brief inline "Checking DEM elevation at origin..." state.
- **`within_bounds: true, reason: null`:** field shows the sampled value,
  **disabled** (not just pre-filled) — per the confirmed behavior, manual
  entry isn't a real option here since the backend will override it
  regardless. Label it clearly, e.g. "812.4 m — from DEM at origin" so
  it doesn't read as a bug that the field can't be edited.
- **`reason: "outside_bounds"` or `"nodata"`:** field becomes/stays a
  normal editable number input, with a short explanatory line above it —
  "Origin falls outside the DEM — enter a target elevation manually." /
  "No elevation data at the origin cell — enter a target elevation
  manually."
- **Preview call failed / not yet resolvable (file or origin incomplete):**
  same as current behavior — plain editable input, no note.

The `formState.targetElevation` value itself stays a single field in
`ProcessingContext` either way — only the input's editability and label
change based on the preview result. Don't add a separate "mode" field for
this the way `originMode` has one; the field's own state machine (checking
/ dem-sourced / manual-required / not-yet-checked) covers it.

---

## Task 5 — Frontend: surface the elevation-source note in results

In `ResultsSuccess.jsx` (from `INTEGRATION_TASKS.md` Task 5), read
`X-Target-Elevation-Note` off the `runProcess` response the same way
`reprojectedFrom` and `warnings` already are, and render it as an
additional `Banner variant="info"` when present. No new banner variant
needed — this is informational, not a warning; the pipeline did exactly
what it's designed to do.

(`runProcess` in `client.js` already reads response headers generically —
just add `X-Target-Elevation-Note` and `X-Target-Elevation-Source` to the
returned object alongside `reprojectedFrom`/`warnings`.)

---

## Task 6 — `write_dem_to_gpkg`: push overwrite-safety into the function

Currently `process_dem` (`app.py`) deletes any pre-existing file at
`output_gpkg_path` before calling `write_dem_to_gpkg` — which protects the
API's usage (job-scoped, single-purpose output paths) but means any
*direct* caller of `write_dem_to_gpkg` (tests, notebooks, future code)
doesn't get that protection automatically and hits GDAL's raise-if-exists
behavior.

Add an `overwrite: bool = True` parameter to `write_dem_to_gpkg`:

```python
def write_dem_to_gpkg(dem_array, transform, crs, gpkg_path, table_name="modified_dem", overwrite=True):
    if overwrite and os.path.exists(gpkg_path):
        os.remove(gpkg_path)
    ...
```

**Document the scope explicitly in the docstring**: this deletes the
*entire* file, not just the named raster table — consistent with the
existing assumption throughout this codebase that one `.gpkg` output path
belongs to one job/run, not a multi-layer file accreted across separate
calls. If a future use case needs to add a raster layer to an existing
multi-layer `.gpkg` without touching other layers, `overwrite=False` opts
out and preserves the current strict-raise behavior — don't try to build
finer-grained per-table deletion now, it's not needed yet and adds
complexity for a use case that doesn't exist in this codebase.

`app.py`'s own top-level delete-before-write guard in `process_dem` stays
as-is — it's still needed for the `include_dem=False` path, where
`write_dem_to_gpkg` is never called at all, so it can't be the one
cleaning up a stale prior output file in that case.

---

## Task 7 — Streaming GPKG writer for the windowed pipeline

This removes "Known limitation" #1 rather than just documenting around it.

New function in `main.py`:

```python
def write_dem_to_gpkg_windowed(source_raster_path, gpkg_path, table_name="modified_dem", tile_size=512, overwrite=True):
    """
    Copies an on-disk raster into a GeoPackage raster table tile-by-tile,
    never holding more than one tile_size x tile_size block in memory.
    Used by the windowed pipeline so include_dem=True no longer negates
    the memory savings windowing exists to provide (see app.py).
    """
```

Implementation: open `source_raster_path` with rasterio, build the same
GPKG profile `write_dem_to_gpkg` uses (driver, `RASTER_TABLE`,
`APPEND_SUBDATASET`), open the destination for write, iterate `tile_size`
windows the same way `tilt_DEM_windowed` does, read+write each block
without accumulating. Apply the same `overwrite` guard as Task 6 — factor
the delete-if-exists logic into a small shared private helper
(`_prepare_gpkg_output(gpkg_path, overwrite)`) used by both functions
rather than duplicating it.

**Verify this actually works before trusting it** — GDAL's GPKG raster
driver should support windowed `dst.write(block, 1, window=window)` calls
the same way GeoTIFF does, but this hasn't been exercised in this codebase
yet. Add a test that writes a synthetic raster via both
`write_dem_to_gpkg` (whole-array) and `write_dem_to_gpkg_windowed`
(tiled) and asserts the two output rasters are numerically identical —
this repo already has exactly this kind of equivalence-testing pattern in
`tests/test_pipeline_equivalence.py`; follow it.

**Wire it into `app.py`:** in the windowed branch's `include_dem` case,
replace:
```python
warnings.warn(
    "include_dem=True with the windowed pipeline reads the entire tilted "
    "raster back into memory to embed it in the GeoPackage, which negates "
    "the memory savings windowing is meant to provide for large files.",
    UserWarning
)
with rasterio.open(tilted_path) as src:
    write_dem_to_gpkg(src.read(1), tilted_transform, crs, output_gpkg_path)
```
with:
```python
write_dem_to_gpkg_windowed(tilted_path, output_gpkg_path, tile_size=tile_size)
```
(Match whatever `tile_size` variable name `tilt_DEM_windowed` was called
with in that branch, so both stages window at the same granularity — not
strictly required for correctness, just tidy.) **Delete the `UserWarning`**
— the condition it described no longer exists.

---

## Task 8 — Tests

- `sample_elevation_at_point`: inside-bounds/valid-data, inside-bounds/
  nodata, outside-bounds cases, using the synthetic-raster fixtures
  pattern already established in `tests/conftest.py`.
- `write_dem_to_gpkg` called twice at the same path: second call
  succeeds (default `overwrite=True`) and the resulting file reflects the
  second call's data, not the first's. Also test `overwrite=False` still
  raises on the second call.
- `write_dem_to_gpkg_windowed` vs `write_dem_to_gpkg` numerical
  equivalence, per Task 7.
- `/api/process` integration test: origin inside DEM bounds with a
  `target_elevation` that deliberately differs from the DEM's actual value
  there — assert the response's `X-Target-Elevation-Source` is `"dem"`,
  `X-Target-Elevation-Note` is present, and (if feasible to check without
  re-parsing the returned `.gpkg`) that the pipeline was actually called
  with the DEM-sampled value, not the submitted one.

---

## Task 9 — Documentation updates

**`README.md`:**
- "Known limitations": remove item #1 (windowed + `include_dem` memory
  behavior — fixed by Task 7). Update item #2 to describe the fix from
  Task 6 rather than describing it as a limitation — something like: "
  `write_dem_to_gpkg` overwrites an existing file at the same path by
  default (`overwrite=True`); pass `overwrite=False` to restore the
  strict raise-if-exists behavior."
- "Documentation" section: currently only lists the geoprocessing-layer
  libraries. Add entries for FastAPI, uvicorn, python-multipart (API
  layer), and React, Vite, Tailwind CSS, Leaflet, georaster-layer-for-leaflet
  (frontend), each with the same one-line-blurb-plus-link style the
  existing entries use. Consider splitting this section into subheadings
  (Backend / API / Frontend) now that the list has grown past one layer —
  your call on whether that's worth it yet.

**`api/README.md`:**
- Add a `POST /api/origin-elevation` section, same style as the existing
  `POST /api/preflight` section (Task 2's contract).
- Update the `target_elevation` row in "Request fields" to note the
  override behavior (a one-line pointer to the new section below is
  enough, don't duplicate the full explanation in the table).
- Add a "Target elevation resolution" section (mirroring "Plausibility
  check"'s structure) explaining the DEM-priority behavior from the
  Background section above, at the contract-documentation level rather
  than the implementation level.
- Add `X-Target-Elevation-Source` / `X-Target-Elevation-Note` to the
  response headers note at the bottom.

**`CLAUDE.md`:**
- Add a bullet to "Key design decisions" recording this as an established
  decision (matches how the 500m threshold and dual file-input decisions
  are already documented there) — something like: "Target elevation is
  DEM-authoritative: when the origin falls inside the DEM on valid data,
  the DEM's own elevation there overrides any submitted `target_elevation`
  (the tilt plane pivots through the origin, so the two must agree for the
  contour to pass through it). Manual entry only applies outside the DEM's
  bounds or on nodata cells. Enforced server-side in `/api/process`;
  `/api/origin-elevation` is a preview-only convenience, not a second
  source of truth."

---

## Optional refactor note (not required, flag only)

`/api/process` and `/api/preflight` (and now `/api/origin-elevation`)
share near-identical "resolve `dem_file` vs `file_path` into a validated
local path" logic. Worth factoring into a shared helper (e.g.
`api/storage.py` or a new small `api/input_resolution.py`) at some point
to avoid three copies drifting out of sync — not urgent enough to block
this pass on, and touching it now would inflate the diff for these three
tasks without changing behavior. Consider it next time any of the three
routes needs a change anyway.
