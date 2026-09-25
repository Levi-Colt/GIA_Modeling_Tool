# GIA Modeling Tool — Shore-Point Uplift Surface Spec

Spec 6 of the Sep 2026 feature set (structural). Touches the backend, API, and
frontend. Implement after `VECTOR_FIELD_SPEC.md` (spec 5). It reuses that
spec's `GridUpliftModel`, isobase contouring, and map layer plumbing.

## Goal

When shore-feature elevation data exist, users can **fit the deformed water
plane directly** instead of describing it with directions and profiles. This
is the computational counterpart of Lewis et al. (2021):

> "Locations for each elevation measurement of each ancient shoreline were
> plotted … and contoured. The resulting lines, or isobases, represent equal
> elevations of isostatic rebound on the GIA deformed surface."

Their supplementary sheet 1 per water body lists site longitude, latitude, and
elevation. This spec imports that kind of table, fits a smooth surface, shows
its isobases and residuals on the map before a run, and runs the model with
it.

## Decisions (made in this spec; flagged for Levi)

- **The fit is a polynomial trend surface of order 1, 2, or 3**, not an exact
  interpolating spline.
  - The paper's own profiles are "usually a second-degree polynomial" with
    isobase curvature kept "gradually and smoothly" varying.
  - Shore elevations scatter by up to 20 m in parts of Lake Agassiz, and an
    exact fit would chase that noise.
  - A smoothing thin-plate spline can be added later as another fit type.
- **Magnitude comes from the data.** The spec-4 profile families and
  `tilt_factor` are not used in this mode.
- **Hinge:**
  - The **default is `none`**: the fitted surface applies as-is on both sides
    of the spillway, since the data define it there.
  - Option **`origin`** clamps `U ≥ 0`, so nothing behind the origin's
    isobase changes. That matches the original basic-mode behavior.
- **Extrapolation guard:** polynomial surfaces diverge quickly outside their
  data.
  - The **default is `warn`**: compute everywhere, and report how much of the
    DEM lies outside the data's buffered convex hull.
  - Option **`mask`**: set the tilted DEM to NaN outside the hull, so no
    contours are extracted there.
- **Import is CSV only.** Users export the relevant sheet from the paper's
  Excel supplementary files. That avoids adding a spreadsheet parser.
- **Blending shore points with vectors in one fit is deferred** to a possible
  spec 7.

---

## F1. The math

All work happens in spec 4's local frame (`_local_en_km`).

### Surface

Each point *j* has frame coordinates `(e_j, n_j)` and elevation `z_j` (m).
For order *p*, fit

```
S(e, n) = Σ_{a+b ≤ p} β_ab · ê^a · n̂^b        with ê = e / L, n̂ = n / L
```

- `L` is the max absolute frame coordinate among the points. Scaling keeps the
  design matrix well conditioned.
- The number of terms is 3, 6, or 10 for p = 1, 2, 3. The constant term is
  included, because S is an absolute elevation surface.
- Solve with `numpy.linalg.lstsq`.

### Minimum points

`n ≥ terms + 3`: 6 for order 1, 9 for order 2, 13 for order 3. Below that,
the fit returns a 422 with a clear message.

Also check conditioning: if `cond(design) > 1e8` after scaling, warn that the
points are nearly collinear or clustered, and that the order is too high for
their spread.

### Uplift

```
U(e, n) = S(e, n) − S(origin)          # origin at (0, 0) in the frame
```

`U(origin) = 0`, so DEM-authoritative target elevation still holds. The
tilted DEM is `DEM − U`, exactly as with every other model.

The isobases the user sees are contours of **S**, labelled in absolute meters
a.s.l., like the paper's maps. The model itself uses U.

### Hinge

- `none`: U as fitted.
- `origin`: `U = max(U, 0)`.

### Fit statistics, returned for every order the point count allows

- n, number of terms, R², adjusted R², RMSE (m).
- Per-point residuals (`z_j − S(e_j, n_j)`).
- Standardized residuals, flagging |r| > 3σ as possible outliers. These are
  shown, never auto-removed.

Returning **all feasible orders** in one response lets the UI show a small
comparison table (F4) at no extra cost: the points are few, so fitting three
orders is trivial.

### Extrapolation guard

1. Take the convex hull of the points in frame coordinates, then buffer it by
   10% of the hull's diameter. The buffer is a module-level constant
   `HULL_BUFFER_FRACTION = 0.10`, marked as a first-pass value in the same
   style as the other tunables.
2. Rasterize the hull onto the working grid (same grid construction as spec 5,
   Step 2) to get `inside_fraction`, the share of the DEM's area inside the
   hull.
3. `warn` mode: if more than 20% of the DEM lies outside, emit a `UserWarning`
   with the percentage.
4. `mask` mode: carry a boolean grid.
   - `evaluate` returns NaN outside the hull (nearest-sample the mask onto the
     block).
   - `DEM − NaN = NaN`, and the existing contour code already excludes NaN
     regions.
   - Also warn with the percentage masked.

## F2. Backend

### New module `backend/uplift_surface.py`

```python
@dataclass(frozen=True)
class ShorePoint:
    lon: float; lat: float; elevation_m: float

def fit_trend_surface(points, origin_coords, diagonal_km, geod, order) -> dict:
    """Returns {"order", "coeffs", "L", "r2", "adj_r2", "rmse_m", "residuals_m", "std_residuals",
    "outlier_indices", "cond", "n", "terms"}. Pure; no raster I/O."""

def fit_all_orders(points, origin_coords, diagonal_km, geod) -> list[dict]: ...

def build_surface_uplift_model(points, order, origin_coords, raster_transform, raster_shape,
                               hinge_mode="none", extrapolation="warn") -> tuple[UpliftModel, dict]:
    """Evaluates S analytically per pixel (no grid needed for S itself -- a polynomial in
    (east_km, north_km) is cheap and exact). The grid is used only for the hull mask and
    the preview isobases. Returns (model, diagnostics)."""
```

### Model: `SurfaceUpliftModel`

This implements spec 4's `UpliftModel`.

- `evaluate(east_km, north_km)` computes S directly from the coefficients,
  subtracts `S(origin)`, applies the hinge, and applies the NaN mask in `mask`
  mode.
- Evaluate S analytically, not from a grid: it's exact and cheap. Use an
  explicit monomial loop over at most 10 terms.
- `extra_bytes_per_pixel = 24` (ê, n̂ temporaries plus the accumulator).
- `evaluate` receives the same broadcastable 1D arrays as spec 5, and
  broadcasts them to the block's 2D shape.

### Wiring

`diagonal_km` and `geod` must match what `_tilt_block` uses for the run.
Compute `diagonal_km` from the full raster, exactly as `tilt_DEM_windowed`
already does, so the fit's frame and the run's frame are identical.

The model is built once in `process_dem`, like spec 5's vector model.

### Isobases for preview

Evaluate **S** on the preview grid and contour it at nice intervals, using
spec 5's helper parameterized for absolute levels. Label each line with
`elevation_m`.

- In `mask` mode, clip the isobases to the hull. In `warn` mode, draw the
  portions outside the hull dashed: return two FeatureCollections, `inside`
  and `outside`.
- Return the hull polygon as GeoJSON in lon/lat, mapped back through
  `_local_en_to_lonlat`.

## F3. API

### `tilt_model.direction` union gains `"points"`

```json
"direction": {
  "type": "points",
  "points": [ { "lat": 49.12, "lon": -96.85, "elevation_m": 331.4, "label": "optional site name" }, … ],
  "order": 2,
  "hinge": "none",              // "none" | "origin"
  "extrapolation": "warn"       // "warn" | "mask"
}
```

In points mode, the top-level `profile` and `hinge` objects must be **absent**.
Reject them with a 422: "profile and hinge don't apply to shore-point surfaces
— magnitude comes from the data". `tilt_azimuth` and `tilt_factor` are not
required, per spec 5's relaxed-field rules.

Validation (422):

- 1–5000 points.
- Valid lat/lon; finite elevation; optional `label` is a string of at most 100 characters.
- `order` ∈ {1, 2, 3}.
- The point count meets F1's minimum for the chosen order.
- Duplicate coordinates are allowed (real data has them).

### New endpoint `POST /api/fit-uplift-surface`

Takes a JSON body `{ points, order, origin, bounds_wgs84, hinge, extrapolation }`
and returns:

```json
{
  "orders": [ {order:1, r2, adj_r2, rmse_m, n, terms}, {order:2, …}, {order:3, …} ],
  "selected": { "order": 2, "residuals_m": [...], "outlier_indices": [...], "cond": … },
  "isobases": { "inside": {GeoJSON}, "outside": {GeoJSON} }, "interval_m": 10,
  "hull": {GeoJSON Polygon},
  "dem_fraction_outside_hull": 0.18,
  "warnings": [...]
}
```

- `orders` covers only the orders the point count allows.
- `selected` is the requested order.
- No raster I/O.

### `/api/process` in points mode

- Adds `X-Tilt-Model-Diagnostics` with the order, R², RMSE, and
  outside-hull fraction.
- `run_parameters.json` gets the full fit statistics and coefficients.
  The **points themselves are written to the zip** as `shore_points.csv`, so
  the run is reproducible from the bundle alone.

## F4. Frontend

### State (`advanced` namespace)

```js
advanced: {
  ...,
  directionSource: 'azimuth' | 'vectors' | 'points',
  shorePoints: [ { lat, lon, elevationM, label } ],   // persisted (spec 3 C2 rule 4 guards quota)
  surface: { order: 2, hinge: 'none', extrapolation: 'warn' },
}
```

The fit response is transient: keep it out of persistence.

### Tilt model section in points mode

- **Direction source** gains a third segment: **Shore points**.
- **Import panel** (reusing spec 5's CSV component, configured for points):
  - Header aliases: `lat|latitude`, `lon|lng|long|longitude`,
    `elevation|elev|elevation_m|z|height`, and optional
    `site|name|site_name|label`.
  - If lat/lon/elevation can't all be matched by header, show a **column
    picker** of three selects, populated from the file's headers, with the
    first five rows previewed. Supplementary spreadsheets have many columns
    and inconsistent names, so this matters.
  - Show the same skipped-rows report as spec 5, with replace/append.
- **Points summary:** "N points" with a "View table" disclosure. The table
  lists site, lat, lon, elevation, and residual; outlier rows are flagged; the
  table is sortable by residual. Rows are editable and deletable, so users can
  remove an obvious outlier.
- **Fit order:** a segmented control **1 | 2 | 3**, with orders the point count
  can't support disabled and a tooltip giving the minimum. Beneath it, a
  compact comparison table from `orders` (order, R², adj. R², RMSE), with the
  selected row highlighted. The comparison is advisory; the user picks.
- **Options:**
  - **Behind the spillway:** a `<select>` with *Apply surface as fitted*
    (`none`, the default) and *No change behind origin* (`origin`).
  - **Outside the data:** a `<select>` with *Warn* (default) and *Mask (no
    contours)*.
- **Hidden in this mode:** the global profile and hinge blocks, replaced by a
  muted note: "Magnitude comes from the fitted surface".
- **Fetching:** debounced (500ms) `POST /api/fit-uplift-surface` whenever
  points, order, options, origin, or bounds change. Ignore stale responses.

### Map

This extends the contract again. It's still render-only, with no editing in
this mode.

```js
mapData: {
  ...,
  shorePoints?: [{ lon, lat, residualM, outlier, label }],
  surfaceIsobases?: { inside: GeoJSON, outside: GeoJSON },
  dataHull?: GeoJSON,
}
```

- **Points:** small circles colored by residual on a **blue ↔ orange
  diverging scale**. That's colorblind-safer than red/green, and the two ends
  also differ in lightness. Outliers get a heavier dark ring. Tooltips show
  the site, elevation, and residual.
- **Isobases:** `inside` solid, `outside` dashed, labelled in m a.s.l.
- **Hull:** a thin dashed outline.
- **Legend:** a compact residual legend in the map's bottom-right, above the
  attribution, shown only in points mode.
- **Layer order:** raster → selection radius → hull → isobases → contour →
  points → origin.

### Readiness and payload

**Readiness** (points mode), keyed to the tilt section:

- At least the minimum point count for the chosen order.
- All points valid.
- `tiltAzimuth` and `tiltFactor` are not required.

**Payload:** `direction.type = 'points'`, with lat, lon, and elevation as
numbers, plus the optional `label` string when present, so `shore_points.csv`
in the zip keeps site names. Omit the top-level `profile` and `hinge`
objects.

---

## Files touched

- **Backend:** `backend/uplift_surface.py` (new); `backend/app.py` (build the
  model up front); spec 5's isobase helper (parameterized for absolute levels
  and hull clipping).
- **API:** `api/tilt_model.py` (the `points` union member and the
  profile/hinge exclusion); `api/main.py` (`/api/fit-uplift-surface`, header,
  `run_parameters` stats, `shore_points.csv` in the zip).
- **Frontend:** `api/client.js` (`fitUpliftSurface`);
  `ProcessingContext.jsx`; `TiltModelBody`;
  `components/advanced/ShorePointsPanel.jsx` (new); spec 5's `CsvImport.jsx`
  (configurable schema plus column picker); `MapPanel.jsx`;
  `utils/readiness.js`; `utils/payload.js`; `utils/colors.js` (new; the
  diverging residual scale, unit-tested).
- **Docs:** `api-README.md`; `CLAUDE.md` (the trend-surface choice and why,
  the hinge and extrapolation defaults, isobases of S vs model U, and
  `shore_points.csv` in the bundle); `VISUALIZATION_PIPELINE_SPEC.md`
  contract.

## Tests

### Python: `tests/test_uplift_surface.py`

- **Exact recovery:** points sampled from a known quadratic surface with no
  noise. The order-2 fit recovers the coefficients to 1e-8 (after unscaling)
  with R² = 1. The order-1 fit has R² < 1.
- **Noisy recovery:** the same surface plus Gaussian noise (σ = 2 m, seeded).
  The order-2 RMSE is ≈ 2 m. A planted 30 m outlier is flagged, and the other
  points are not.
- **Planar equivalence:** points from a plane tilted along azimuth 28° at
  0.35 m/km through the origin elevation. With `hinge='none'`, the order-1
  surface U matches spec 4's `PlanarUpliftModel` (linear, no hinge) within
  1e-6 m. With `hinge='origin'`, it matches the planar model with an `origin`
  hinge.
- **Minimum-points and conditioning:** point counts below the minimum fail
  per order; collinear points warn.
- **Hull and mask:** with points covering half the DEM, `dem_fraction_outside_hull`
  is ≈ 0.5 ± grid tolerance. In `mask` mode, contours appear only inside the
  hull. In `warn` mode, a warning appears when more than 20% is outside.
- **`U(origin) = 0`** for every order and hinge.
- **Windowed vs in-memory** equivalence with a surface model.

### Python: `tests/test_api_tilt_model.py` additions

- `points` validation, including `profile`/`hinge` present being rejected.
- `/api/fit-uplift-surface` returns only the feasible orders.
- `shore_points.csv` and the fit stats are present in a points-mode zip.

### Vitest

- CSV import with a messy multi-column header: the column picker appears, and
  mapping yields the right points.
- The residual color scale maps endpoints and zero correctly.
- Readiness per order minimum; payload omits `profile`/`hinge`.
- `ShorePointsPanel` disables infeasible orders.

### Manual check

1. Import a strandline point file for a basin with an available DEM, e.g.
   Lake Agassiz Campbell-level points from the paper's supplementary sheet,
   exported to CSV. The points appear, colored by residual.
2. Compare orders 1, 2, and 3 in the table. The isobases are roughly parallel
   and more closely spaced toward the north, matching the paper's Fig. 11.
3. Switch the outside-data option to Mask: contours stop at the hull.
4. Delete a flagged outlier: the fit updates and RMSE drops.
5. Run the model and open `run_parameters.json` and `shore_points.csv` from
   the zip: both reflect exactly what was fitted.
