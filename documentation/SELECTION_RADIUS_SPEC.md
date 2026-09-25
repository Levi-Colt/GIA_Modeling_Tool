# GIA Modeling Tool — Selection Radius Spec

Spec 2 of the Sep 2026 feature set. This is a **basic** feature (available in
both the current form and the future Basic/Advanced modes). It touches
`backend/app.py`, `backend/main.py`, `api/main.py`, and the frontend.
Implement after `MAP_QOL_SPEC.md`, but it does not depend on it.

## Goal

The user can optionally enter a selection radius in km. Only strandline
contours that come within that distance of the origin (the spillway
coordinate) are written to the output GeoPackage and shown on the map.
Everything else about the run is unchanged.

## Semantics (decided)

- **Optional.** Empty or absent means no filtering, byte-for-byte identical to
  today's output.
- **Units: km**, measured geodesically (WGS84 ellipsoid) from the resolved
  origin.
- **Keep-whole ("intersects") is the only mode exposed in the UI.** A contour
  is kept, entire and unclipped, if any part of it comes within the radius.
  Contours entirely outside are dropped.
- **Clipping is supported in the backend but not exposed.** A second mode,
  `"clip"`, trims kept contours at the circle's edge. It's a fallback in case
  real-data testing shows long contours defeating the radius's purpose. The
  windowed branch's `linemerge` is where such long lines would show up first.
  Turning it on later is a UI-only change.
- **The origin may lie outside the DEM.** That's already allowed within the
  500 m plausibility threshold, and the radius works the same way.
- **The tilted DEM raster is not cropped.** The radius filters contours only.

---

## B1. Backend

### `backend/main.py`: new function

```python
def select_contours_within_radius(lines, origin_coords, radius_km,
                                  mode="intersects", circle_vertices=256):
    """
    Filter (and optionally clip) strandline LineStrings to those within
    radius_km of origin_coords, measured geodesically on WGS84.

    lines: list of shapely LineStrings in lon/lat degrees (the same
        CRS-naive geographic-degrees contract as the rest of this module --
        see _raster_diagonal_km's docstring; no reprojection here).
    mode:
        "intersects" -- keep a line unchanged if ANY vertex is within
            radius_km (geodesic distance via one vectorized Geod.inv call
            per line). Vertex-based is exact to within the contour's own
            vertex spacing, which is ~pixel-scale by construction
            (marching squares), so no line-segment/circle math is needed.
        "clip" -- build the circle as a lon/lat polygon from
            circle_vertices Geod.fwd bearings around the origin, and
            return each line's intersection with it (dropping empties and
            splitting MultiLineStrings into LineStrings via _as_line_list-
            style normalization). Straight lon/lat edges between 256
            geodesic vertices are a negligible approximation at this
            tool's precision.
    Returns a new list; never mutates the input.
    Raises ValueError for radius_km <= 0 or non-finite, or unknown mode.
    """
```

This uses `pyproj.Geod` only, the same geodesic tooling `calculate_tilt`
already uses. There's no CRS transformation, so it stays within `CLAUDE.md`'s
rule that CRS handling lives in `api/crs.py`.

### `backend/app.py`: `process_dem`

Add two keyword arguments. The defaults preserve current behavior:

```python
def process_dem(file_path, origin_coords, tilt_azimuth, tilt_factor,
                target_elevation, output_gpkg_path, include_dem=True,
                selection_radius_km=None, selection_mode="intersects"):
```

Apply the selection **after** the existing `MIN_CONTOUR_VERTICES` filter and
`simplify` step, **before** building the GeoDataFrame. This follows the same
reasoning as Fix 3's placement: the windowed branch's fragments must be judged
as fully assembled lines, not per-tile pieces.

```python
if selection_radius_km is not None:
    before = len(lines)
    lines = select_contours_within_radius(lines, origin_coords, selection_radius_km,
                                          mode=selection_mode)
    if not lines and before > 0:
        warnings.warn(
            f"No strandline contours fall within {selection_radius_km:g} km of the "
            f"origin ({before} found in the full DEM). Try a larger selection radius.",
            UserWarning,
        )
```

`api/main.py` already surfaces `UserWarning`s through
`X-Processing-Warnings`, so this reaches the user with no extra plumbing.

**Empty output.** First check what `gdf.to_file(...)` does today with an empty
`lines` list (this can already happen when `find_contours` returns nothing).
If it raises, write an empty layer with a declared schema (e.g.
`gpd.GeoDataFrame(geometry=gpd.GeoSeries([], crs=crs))`, and pass
`schema={"geometry": "LineString", "properties": {}}` if the installed engine
needs it) so an empty result is a valid, downloadable GeoPackage with a
warning, not a 500. Cover it with a test either way.

`process_dem`'s return value does not change.

**`CLAUDE.md` convention change.** `backend/app.py` was previously kept at zero
diff. This spec changes it deliberately, and the upcoming uplift-model
refactor will too. Update the relevant `CLAUDE.md` entries to say the backend
now changes when a feature genuinely belongs there, with new behavior behind
defaulted keyword arguments so the basic path stays identical.

## B2. API (`api/main.py`)

New form field on `POST /api/process`:

```python
selection_radius_km: float | None = Form(
    None, description="Optional: keep only strandline contours within this many km of the origin"
),
```

- Validate up front with the other input checks. If present, it must be finite
  and `> 0`; otherwise return a 422 with a clear `detail`.
- Pass it through to `process_dem(..., selection_radius_km=selection_radius_km)`.
  Do **not** expose `selection_mode` as a form field yet.
- When a radius was applied, add a response header after the existing
  `contour_gdf` read-back:
  `X-Selection-Summary: "{len(contour_gdf)} strandline contour(s) kept within {r:g} km of the origin."`
  This counts only what was kept. `process_dem`'s return stays unchanged, so
  the pre-filter total isn't available here, and the empty-result warning
  above already carries the total when it matters most.
- `contour.geojson` in the zip is built from the filtered `.gpkg`, so the map
  preview automatically matches the download. No change is needed there.

Update `documentation/api-README.md`: add a request-fields table row for
`selection_radius_km`, a note on the new header, and the keep-whole semantics.

## B3. Frontend

### State: `ProcessingContext.jsx`

Add `selectionRadiusKm: ''` to `defaultState`. It's persisted, since it's a
user input and not transient status, so leave it out of the destructured
non-persisted list.

### Input: `TiltAndProductsSteps.jsx`

Add the field to `ProductsStep`, above the include-DEM checkbox, and rename the
step label from `5 · Return products` to `5 · Output`. Keep the `id` `products`
so `StepRail` / `scrollToStep` are unaffected.

```jsx
<label className="block text-sm text-gray-600">
  Selection radius (km, optional)
  <input type="number" min="0" step="any" placeholder="No limit"
         value={formState.selectionRadiusKm}
         onChange={(e) => updateForm({ selectionRadiusKm: e.target.value })}
         className="mt-1 w-full" />
</label>
<p className="text-xs text-gray-500">
  Only contours that come within this distance of the origin are kept (whole, not clipped).
</p>
```

This placement is interim. The upcoming input-interface spec may move it.

### Readiness: `utils/readiness.js`

If `selectionRadiusKm` is non-empty and not a finite number `> 0`, add
`'a positive selection radius (or leave it empty)'` to `missing`. This uses
`getReadiness` from `MAP_QOL_SPEC.md`. If that spec isn't in yet, add the
equivalent `return false` to `isReadyToRun`.

### Payload: `App.jsx` `buildProcessPayload`

```js
...(formState.selectionRadiusKm !== '' ? { selection_radius_km: formState.selectionRadiusKm } : {}),
```

### Summary: `api/client.js` and `ResultsSuccess.jsx`

`runProcess` reads `X-Selection-Summary` alongside the other headers and
returns it as `selectionSummary`. `App.jsx` threads it into `result`, the same
way as `elevationNote`, and `ResultsSuccess` shows it in an `info` `Banner`.
Also add `· Radius {r} km` to the parameter line when a radius was set.

### Map: radius circle

This extends the `MapPanel` contract with one new optional field, so the
component stays a dumb renderer:

```js
selectionRadius?: { center: [lon, lat], radiusKm: number }
```

- **Where it's derived:** in `deriveMapDataFromForm` (the input-preview
  adapter), only when `resolvedOrigin` exists and the radius is a valid
  positive number. It appears as soon as the user types a radius, before any
  run, and carries into the results view like the other input-preview fields.
- **How it's rendered in `MapPanel`:**
  `L.circle([lat, lon], { radius: radiusKm * 1000, color: '#7c3aed', weight: 1.5, dashArray: '4 4', fill: false, interactive: false })`.
  Leaflet's `L.circle` radius is in meters with latitude correction, which is
  close enough to the geodesic circle for a visual guide.
- **Layer order:** above the raster, below the contour.
- **Bounds:** do not include the circle in the fit-bounds priority chain. The
  existing chain (contour → raster → extent) stays as is.

Update the contract comment at the top of `MapPanel.jsx`, the map-contract
section of `documentation/VISUALIZATION_PIPELINE_SPEC.md`, and the
`MapPanel` shape in `CLAUDE.md`.

---

## Tests

### Python

New file `tests/test_select_contours_within_radius.py`:

- A line with one vertex inside the radius and the rest far outside is kept
  unchanged in `"intersects"` mode.
- A line entirely outside is dropped.
- A line whose nearest vertex sits just inside vs. just outside the radius
  (e.g. ±50 m at a 10 km radius, placed via `Geod.fwd`) is kept vs. dropped.
- A line fully inside is kept unchanged.
- In `"clip"` mode, a line crossing the circle comes back shorter, and all its
  vertices lie within the radius plus a small tolerance (e.g. 5 m). A line that
  crosses the circle twice yields two pieces.
- `radius_km` of `0`, a negative value, `nan`, or `inf`, or an unknown mode,
  raises `ValueError`.
- The input list is not mutated.

Additions to `tests/test_process_dem.py`, reusing the synthetic dome fixture
style from `test_pipeline_equivalence.py` so contours form rings:

- `selection_radius_km=None` produces the same contour layer as omitting the
  argument (regression guard).
- A radius that reaches the ring keeps it; a radius too small to reach it
  produces an empty-but-valid GPKG plus the `UserWarning`.
- Run both in-memory and windowed branches (force windowed the same way the
  existing windowed tests do) and confirm they agree with a radius applied.

API (`tests/test_api_process_*`):

- A radius of `0` or `-5` returns 422.
- A valid radius returns 200 with `X-Selection-Summary` present.
- No radius means no `X-Selection-Summary` header.
- An empty selection returns 200 with the warning in `X-Processing-Warnings`
  and a zip whose `contour.geojson` has zero features.

### Frontend (Vitest)

- Readiness: an empty radius is fine; `0`, `-1`, and `abc` each block the run
  with the radius reason; `12.5` is fine.
- `buildProcessPayload`: includes `selection_radius_km` only when the radius is
  non-empty. Export it from `App.jsx` or move it to `utils/` for testing, your
  choice, and note which in `frontend-README.md`.

Full suite: `pytest -c setup/pytest.ini --rootdir=.`, `npm test`, and
`npm run build` all pass. The only failure allowed is the known pre-existing
numpy one.

### Manual check

1. Enter a radius before running: a dashed circle appears around the origin
   marker.
2. Run: only contours touching the circle are shown and downloaded, the
   summary banner shows the count, and contours that cross the circle are
   kept whole.
3. Use a tiny radius that reaches no contour: the download still works, and a
   warning banner suggests a larger radius.
4. Clear the radius and re-run: output matches a run without the feature.
