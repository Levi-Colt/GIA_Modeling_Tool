# GIA Modeling Tool — Vector Direction Field Spec

> **Amended by `UPLIFT_MODEL_CORRECTIONS_SPEC.md` (spec 4a): hinge modes,
> quadratic input forms, and user-facing text. Where they conflict, 4a
> wins.** Concretely: the hinge is `origin | distance | none` (default
> `origin` for every family; the zero-gradient point is a *guard*, not a
> hinge), a custom `quadratic` takes either a rate of increase or a second
> gradient, and every user-facing label, help text and message is
> location-agnostic and spillway-anchored. The edits to E1 Step 5, E3 and E4
> below apply this, so spec 5 isn't implemented against stale text.

Spec 5 of the Sep 2026 feature set (structural). It touches the backend, API,
and frontend, including map editing. Implement after `UPLIFT_MODEL_SPEC.md`
(spec 4). It adds a new `UpliftModel` implementation behind that spec's
interface.

## Goal

Lets a user model **multi-directional tilt** where shore-feature data are too
sparse to fit a surface. The user supplies vectors, each with a location, an
azimuth (the direction of maximum uplift there), and an optional range. The
tool builds a smooth uplift surface whose isobases bend to follow them.
Magnitude comes from the spec-4 profile families, applied either globally or
per vector.

This matches how Lewis et al. (2021) describe basins: the direction of maximum
uplift rotates within a single basin (Lake Algonquin's 200 m isobase runs from
002.5° to 031°), and isobases are "adjusted … to form a suite of lines … that
varied gradually and smoothly from place to place".

## Decisions carried in from design

- **Vector fields:** location (decimal-degree lat/lon), azimuth (degrees), and
  optional **range (km)**. Range is the vector's *range of influence*, how far
  its direction is trusted. It is **not** a magnitude.
- **Magnitude** comes from a **global profile** (spec 4: family, `tilt_factor`
  as gradient at origin, hinge). A vector can optionally carry a **custom
  tilt**:
  - The custom tilt's gradient is the **local gradient at the vector's own
    location**, the way the literature measures gradients (Table 3 values are
    taken at specific isobases, not at outlets).
  - Custom tilts support **linear** (local gradient) and **quadratic** (local
    gradient plus local rate of increase) only. Polynomial stays global-only.
  - The global profile is required only if at least one vector uses it.
- **Map editing:** click-and-drag on the map to add vectors, and drag handles
  to move or rotate them. The table stays the accessible, precise path, and
  CSV import is supported.
- **Single-vector regression:** one vector with the global profile must
  reproduce the planar (azimuth) model.

---

## E1. The math

All geometry happens in spec 4's local frame (`_local_en_km`, east/north km
from the origin). Don't build a second projection.

### Step 1: vectors into the frame

For each vector *i*:

- **Position:** `(e_i, n_i) = _local_en_km(lon_i, lat_i, ...)`.
- **Direction:** take the point 1 km along the azimuth with
  `Geod.fwd(lon_i, lat_i, az_i, 1000)` and map it into the frame. The unit
  vector from `(e_i, n_i)` toward it is **v̂_i**. Mapping two points avoids
  hand-correcting bearings for the frame's scale distortion away from the
  origin.
- **Range:** `R_i` is taken from `range_km` if given. The default is
  `R_default`: the median nearest-neighbour distance between vectors, or, for
  a single vector, 0.5 × the DEM's frame-diagonal.

### Step 2: working grid

The grid is a regular grid over the DEM's frame bounding box, taken from the
four corners mapped through `_local_en_km`, plus 5% padding on every side.

- **Cell size:** `h = max(width, height) / 255`. That gives at most 256 cells
  on the long side; scale the short side to match with square cells.
- **Memory:** the grid is small (≤ 256×256 float64 arrays), independent of DEM
  size. It is built once per run.

### Step 3: direction field v̂(x)

At each grid node, take a weighted mean of the unit vectors:

```
w_i(x) = taper_i(x) / (r_i(x)² + h²)          r_i = distance from node to vector i (km)
taper_i(x) = max(exp(-(r_i / R_i)²), 1e-6)    floor keeps the field defined everywhere
V(x) = Σ w_i v̂_i ;   v̂(x) = V / |V|
```

The floor makes nodes far from every vector fall back to plain
inverse-distance behavior. That keeps the result deterministic, with no
undefined regions.

**Degenerate nodes.** Where `|V| / Σ w_i < 0.05`, nearby vectors point in
nearly opposite directions. At those nodes, use the nearest vector's
direction and count them. If more than 1% of nodes are degenerate, emit a
`UserWarning`: *"Vectors disagree strongly (near-opposite directions) over N%
of the area; isobases there are unreliable."*

Vectors pointing opposite ways is almost always a data-entry error, such as
azimuth 208 vs 028.

### Step 4: curved distance coordinate φ (pass 1)

Solve for φ on the grid so that ∇φ ≈ v̂ in least squares, with the constraint
φ(origin) = 0.

- **Equations:** one per grid edge:
  - horizontal edges: `(φ[r, c+1] − φ[r, c]) / h = v̂_e` at the edge midpoint;
  - vertical edges: `(φ[r+1, c] − φ[r, c]) / h = v̂_n` at the edge midpoint.

  Edge-midpoint values are the average of the two nodes. Mind the frame
  convention: grid row `r` increases **northward** in frame coordinates; keep
  that consistent in the interpolation step.
- **Solve:** build the sparse system with `scipy.sparse`, form the normal
  equations (`AᵀA φ = Aᵀb`), and pin one node, the one nearest the origin, to
  0 to remove the constant null space. Solve with
  `scipy.sparse.linalg.spsolve`.
- **Anchor exactly:** subtract the bilinearly interpolated φ at the exact
  origin position so φ(origin) = 0.
- **Meaning:** φ is "km along the uplift direction", and its contours are the
  isobases.

**Dependency.** `scipy` is new at the top level. It's already installed as a
dependency of `scikit-image`, but list it explicitly in
`setup/requirements.txt` and `environment.yml`.

**Why least squares.** A real direction field that curves isn't exactly the
gradient of anything; it has nonzero curl. Least squares gives the closest
consistent isobase pattern, and E1.6 reports how close it is.

### Step 5: uplift U

**Case A: every vector uses the global profile.** Then `U = profile.U(max(φ, d_h))`,
using spec 4's `PolynomialProfile` and its hinge `d_h`, resolved exactly as in
spec 4 as amended by 4a G1 (the mode's point, then the zero-gradient guard:
`PolynomialProfile.resolve_hinge`). This is exact, and no second solve is
needed.

**Case B: at least one vector has a custom tilt.** Build a gradient-magnitude
field and integrate it (pass 2).

1. **Local gradient functions**, one per vector, as functions of φ:
   - Global vector: `G_i(φ) = g_global(φ)`, the spec-4 derivative.
   - Custom linear: `G_i(φ) = g_i`.
   - Custom quadratic: `G_i(φ) = g_i + k_i · (φ − φ_i)`, where `φ_i` is φ at
     the vector's own location. This is why the custom gradient is "local": it
     equals `g_i` at the vector.
2. **Gradient field:** `G(x) = Σ w_i(x) G_i(φ(x)) / Σ w_i(x)`, using the same
   weights as Step 3.
3. **Hinge, in gradient form** (4a G1 modes). The global profile's hinge
   mode applies to the whole field:
   - `origin` (the default, for every family): `G = 0` wherever φ < 0.
   - `distance`: `G = 0` wherever `φ < −distance_km`.
   - `none`: no mode clamp; the field continues behind the spillway.

   In every mode the guard also applies: where φ < 0 and `G < 0`, set
   `G = 0`, so uplift never re-increases behind the spillway. With `none`, that
   means only the guard applies (`G ≥ 0` behind the spillway). When the guard,
   not the mode, sets a clamp, report it as information (spec 4a's
   `hinge_source: "guard"`), not a warning.
4. **Integrate:** solve ∇U ≈ G · v̂ with the same least-squares machinery as
   Step 4, then anchor U(origin) = 0.

**Consistency check (tested):** if every vector's custom tilt is set equal to
what the global profile implies at its location, Case B must match Case A
within the grid-discretisation tolerance.

### Step 6: diagnostics

Compute these and return them from both `/api/process` and the preview
endpoint (E3):

- **Per-vector direction misfit:** the angle, in degrees, between ∇φ
  (central differences, bilinearly sampled) and v̂_i at the vector location.
- **Overall misfit:** RMS and max across vectors.
- **Warning threshold:** if the max misfit exceeds 15°, add a `UserWarning`
  naming the worst vector's index. This indicates vectors the smooth surface
  can't honor simultaneously.
- **Coverage:** add a `UserWarning` if any vector lies outside the DEM's
  bounding box expanded by 50% of its diagonal. The vector still counts, but
  it's probably a typo.

## E2. Backend structure

### New module `backend/direction_field.py`

```python
@dataclass(frozen=True)
class Vector:
    lon: float; lat: float; azimuth_deg: float
    range_km: float | None
    custom: dict | None     # {"family": "linear"|"quadratic", "local_gradient": g, "rate_of_increase": k|None}

@dataclass(frozen=True)
class GridUpliftModel(UpliftModel):
    """U precomputed on a regular frame grid; evaluate() bilinearly samples it."""
    e0: float; n0: float; h: float          # grid origin (south-west node) and spacing, frame km
    U: np.ndarray                           # (rows, cols), row index increases northward
    extra_bytes_per_pixel: int = 24
    def evaluate(self, east_km, north_km): ...  # scipy.ndimage.map_coordinates(order=1, mode="nearest")

def build_vector_uplift_model(vectors, origin_coords, raster_transform, raster_shape,
                              global_profile, global_hinge_d) -> tuple[GridUpliftModel, dict]:
    """Returns (model, diagnostics). diagnostics = {"misfit_deg": [...], "misfit_rms_deg",
    "misfit_max_deg", "degenerate_fraction", "phi_grid", "grid": {...}} -- phi_grid kept for
    the preview endpoint's isobases, not used by evaluate()."""
```

`evaluate` receives broadcastable 1D east/north arrays from the fast path
(spec 4's `_lonlat_grid` returns shapes (1, W) and (H, 1)). Broadcast them to
2D before `map_coordinates`, in the block's own shape. That's per-block memory
only, which is what the 24 B/pixel covers: two float64 coordinate arrays plus
the output.

**Windowing.** The model is built once in `process_dem`, before either branch
runs, from the full raster's transform and shape. That needs a cheap
`rasterio.open` to read the metadata, and `raster_io_check` already opens the
file. The same object is then used for every block, so the windowed and
in-memory branches agree automatically.

**Isobase geometry for previews.** Contour `U` on the grid with
`skimage.measure.find_contours` at "nice" levels. Aim for 8–12 levels: the
interval is the smallest of 1/2/5×10ⁿ m that yields ≤ 12 levels across U's
range. Map grid indices to frame km, then to lon/lat through spec 4's
`_local_en_to_lonlat`. Output is a GeoJSON FeatureCollection of LineStrings
with a `uplift_m` property.

## E3. API

### `tilt_model` schema (version 1, extended)

```json
"direction": {
  "type": "vectors",
  "vectors": [
    { "lat": 49.9, "lon": -97.2, "azimuth_deg": 28, "range_km": 150, "custom": null },
    { "lat": 52.8, "lon": -99.1, "azimuth_deg": 33, "range_km": null,
      "custom": { "family": "quadratic", "local_gradient": 0.6,
                  "second_gradient": { "gradient_m_per_km": 1.0, "distance_km": 120 } } }
  ]
}
```

A custom `quadratic` takes **either** `rate_of_increase` **or**
`second_gradient` (4a G2: mutually exclusive, exactly one required). Here
`second_gradient` is relative to the vector's own location, so the API converts
with `k_i = (gradient_m_per_km − local_gradient) / distance_km` and everything
downstream (and `run_parameters.json`, which records the form supplied and the
derived `rate_of_increase`) uses the canonical `k_i`. `distance_km` is measured
up the uplift direction from the vector's location.

**Validation** (422 on any failure) goes in `api/tilt_model.py`, which gains
`direction` as a discriminated union on `type`:

- 1–200 vectors.
- `lat` in [−90, 90], `lon` in [−180, 180], `azimuth_deg` in [0, 360).
- `range_km`, if present, finite and > 0.
- Custom `family` in `{linear, quadratic}`. `quadratic` requires exactly one
  of a finite `rate_of_increase` or a `second_gradient` (`gradient_m_per_km`
  finite, `distance_km` finite and > 0); `linear` forbids both.
  `local_gradient` must be finite.

**Relaxed form fields.** For `direction.type != "azimuth"`, `tilt_azimuth` is
not needed. Make it `Form(None)`.

- If `tilt_azimuth` is missing, return a 422 when either the direction type is
  `azimuth`, or no `tilt_model` is given (a basic run).
- `tilt_factor` likewise becomes `Form(None)`. It's required whenever the
  global profile is used: the direction is `azimuth`, or any vector has
  `custom: null`.

Error messages must say which condition applied, e.g. *"tilt_factor (global
gradient at origin) is required because vector 3 uses the global profile."*

**Diagnostics header.** `/api/process` in vectors mode adds a compact JSON
header:

```
X-Tilt-Model-Diagnostics: {"misfit_rms_deg":…,"misfit_max_deg":…,"worst_vector":…}
```

The full per-vector list goes in `run_parameters.json` under `diagnostics`.

### New endpoint `POST /api/uplift-preview`

This generalizes spec 4's profile preview to spatial models. It takes a JSON
body:

```json
{ "tilt_azimuth": …, "tilt_factor": …, "tilt_model": {…},
  "origin": [lon, lat], "bounds_wgs84": [w, s, e, n] }
```

Both `origin` and `bounds_wgs84` are required here.

- **How it builds the model:** it constructs a synthetic transform and shape
  from the bounds, so the grid matches what a real run on that DEM would
  build. Use `rasterio.transform.from_bounds` with, say, 512×512. Only the
  bounds matter to the grid, not pixel counts. No raster I/O.
- **Response:**

```json
{ "isobases": {GeoJSON FeatureCollection}, "interval_m": 10,
  "vectors": [{"index": 0, "misfit_deg": 2.1}, …],
  "misfit_rms_deg": …, "misfit_max_deg": …,
  "warnings": [...] }
```

- **Timing:** it must answer in well under a second at the 256² grid. If
  profiling says otherwise, drop the preview grid to 128² and keep the run at
  256², noting it in the response as `"preview_grid": 128`.

Keep `/api/profile-preview` for azimuth mode. The frontend calls one or the
other based on the direction source.

## E4. Frontend

### State (`advanced` namespace)

```js
advanced: {
  ...,
  directionSource: 'azimuth',        // 'azimuth' | 'vectors'   (spec 6 adds 'points')
  vectors: [                          // persisted
    { id: 'v_…', lat: '', lon: '', azimuthDeg: '', rangeKm: '',
      tilt: 'global',                 // 'global' | 'custom'
      custom: { family: 'linear', localGradient: '',
                curvatureInput: 'secondGradient',   // 4a G2, same as the global profile
                rateOfIncrease: '', secondGradient: '', secondGradientDistanceKm: '' } }
  ],
  selectedVectorId: null,             // transient (exclude from persistence)
}
```

Keep the fields as strings to match existing input handling. Use stable ids
(`crypto.randomUUID()` with a fallback) as React keys and for map links.

### Tilt model section

- **Direction source:** a segmented control at the top of `TiltModelBody`:
  **Single azimuth | Vectors**. Spec 6 adds Shore points.
- **Vectors table**, per canvas artboard B:
  - **Columns:** #, Lat, Lon, Azim °, Range km, Tilt (Global/Custom), Fit °
    (from preview misfits, shown in amber above 15°), and a remove button with
    an `aria-label`.
  - **Custom rows** expand below the row with the family (Linear/Quadratic),
    local gradient (m/km), and, for quadratic, the same **"Curvature from"**
    control as the global profile (4a G2): *Second gradient* (a gradient, and
    the distance up the uplift direction from this vector) or *Rate of increase*
    (m/km per km). Values in the hidden form are kept. The rate uses the same
    `e`-notation-friendly text input as spec 4. Help text and placeholders
    follow 4a G3 (generic, units only).
  - **Selection:** selecting a row (focus or click) sets `selectedVectorId`,
    which highlights its arrow on the map, and vice versa.
  - **Above the table:** "+ Add row", "Add on map" (a toggle, see E5), and
    "Import CSV".
- **Global profile block:** spec 4's family, parameters, and hinge controls,
  labelled **Global profile (whole DEM)**. Show a muted note when every vector
  is custom: "Global profile not used — every vector has a custom tilt". Keep
  the fields editable and the values kept.
- **Chart:** in vectors mode, spec 4's chart is replaced by the map isobases
  and the misfit summary line. Showing a single 1D profile would mislead once
  directions vary.

### CSV import

**Parsing** uses `papaparse`, a new dependency (small and robust with quoted
fields).

- **Header matching** is case-insensitive:
  - `lat|latitude`, `lon|lng|long|longitude`, `azimuth|azimuth_deg|az`,
    `range|range_km` (optional), `gradient|local_gradient` (optional),
    `rate|rate_of_increase` (optional).
  - A row with a gradient becomes custom: linear, or quadratic if a rate is
    present.
- **Invalid rows:** show a small inline report ("12 imported, 2 skipped: row
  5 azimuth missing, row 9 latitude out of range"). Don't fail silently, and
  don't import partial rows.
- **Existing vectors:** ask "Replace existing vectors / Append" with two
  buttons in the import panel, not a browser `confirm()`.

### Readiness and payload

**Readiness** (advanced, `directionSource === 'vectors'`), all keyed to the
tilt section:

- At least one vector.
- Every vector has a valid lat, lon, and azimuth.
- Any range is > 0.
- Custom rows are complete.
- `tiltFactor` and the global profile fields are valid if any row is Global.
- `tiltAzimuth` is **not** required in vectors mode.

**Payload:** `direction.type = 'vectors'`, with each vector serialized as
numbers and `range_km: null` when empty. Omit `tilt_azimuth` in vectors mode.
Omit `tilt_factor` only when every vector is custom.

## E5. Map: display and editing

This extends the `MapPanel` contract. `MapPanel` still never computes models:
it renders what it's given and reports geometry edits through callbacks.
Bearing and distance math lives in `utils/geometry.js`, using turf
(`@turf/bearing` and `@turf/distance`, new individual packages), not inside
`MapPanel`.

```js
mapData: {
  ...existing,
  vectors?: [{ id, lon, lat, azimuthDeg, rangeKm, lengthKm, selected, custom }],
  isobases?: GeoJSON,           // from /api/uplift-preview, drawn with uplift labels
}
// new optional props:
editing?: {
  mode: 'none' | 'addVector',
  onAddVector({ lon, lat, azimuthDeg, rangeKm }),
  onUpdateVector(id, { lon?, lat?, azimuthDeg?, rangeKm? }),
  onSelectVector(id),
  onExitAddMode(),
}
```

### Rendering

- **Arrows:** each vector is a geodesic arrow from its location along its
  azimuth.
  - Length is `lengthKm`, computed in the adapter: `rangeKm` if set,
    otherwise 10% of the DEM diagonal.
  - Draw a polyline with a small arrowhead from `@turf/destination` points.
  - Custom-tilt vectors get a filled head; global ones a hollow head. Selected
    vectors are drawn thicker in the accent color.
  - Label each arrow with its row number, matching the table.
- **Isobases:** thin blue lines, labelled at one end with relative uplift, e.g.
  `+40 m`. The origin's isobase (`0`) is slightly heavier.
- **Layer order:** raster → selection radius → isobases → contour → vectors →
  azimuth line (azimuth mode only) → origin.

### Editing interactions

**Add on map** (`editing.mode === 'addVector'`):

1. The cursor becomes a crosshair and map panning is disabled
   (`map.dragging.disable()`, re-enabled on exit).
2. Pointer down sets the base point. Dragging shows a live preview arrow and a
   small tooltip with the azimuth and length.
3. Pointer up calls `onAddVector` with the bearing and geodesic length from
   `utils/geometry.js`. The dragged length becomes `rangeKm`.
4. A drag shorter than 8 screen px counts as a click: the vector is added with
   an empty azimuth and the table focuses that row's azimuth input.
5. Add mode stays on for repeated adds until the user toggles it off, presses
   Escape (listener scoped to the map container, not `window`), or clicks
   "Done".

**Existing vectors:**

- Each has two draggable handles: `L.marker` with a small `divIcon`, with
  `keyboard: false`, since the table is the keyboard path.
- The **base handle** moves the location.
- The **tip handle** rotates and resizes: it updates the azimuth and
  `rangeKm` on drag end.
- Clicking an arrow selects it.

**Events and updates:**

- Use pointer events so touch works.
- Commit to state on drag end only. During a drag, update the Leaflet layers
  imperatively, so the preview request isn't spammed.
- The preview request is debounced (500ms) off state changes.

**Undo:** keep the last 20 vector-list states in a ref, with an "Undo"
button beside "Add on map". This is cheap and matters for map editing.

## E6. Result consistency

Isobases shown on the map come from `/api/uplift-preview`, which builds its
grid from the preflight bounds. The run builds from the real raster's
transform. They should be identical when the raster is EPSG:4326, and
negligibly different when it was reprojected, since preflight bounds are the
reprojected WGS84 bounds.

Document this in `CLAUDE.md`. If a test shows they diverge, trust the run.

---

## Files touched

- **Backend:** `backend/direction_field.py` (new); `backend/app.py` (build the
  model up front when requested); `setup/requirements.txt` and
  `environment.yml` (scipy).
- **API:** `api/tilt_model.py` (the `direction` union, relaxed-field rules);
  `api/main.py` (optional `tilt_azimuth`/`tilt_factor`, diagnostics header,
  `run_parameters` diagnostics, `/api/uplift-preview`).
- **Frontend:**
  - `api/client.js` (`upliftPreview`);
  - `ProcessingContext.jsx` (defaults, transient exclusions);
  - `TiltModelBody`, `components/advanced/VectorTable.jsx` (new) and
    `CsvImport.jsx` (new);
  - `MapPanel.jsx` (vectors, isobases, editing);
  - `utils/geometry.js` (bearing, distance, arrow geometry);
  - `utils/readiness.js`, `utils/payload.js`;
  - `package.json` (`papaparse`, `@turf/bearing`, `@turf/distance`).
- **Docs:**
  - `api-README.md`: schema, relaxed fields, header, and the new endpoint.
  - `CLAUDE.md`: the vector-field method (weights, least-squares φ, the two
    passes), "range is influence, not magnitude", "custom gradients are local",
    `MapPanel`'s editing contract ("still no geoprocessing"), and the E6
    consistency note.
  - `VISUALIZATION_PIPELINE_SPEC.md`: the contract section.

## Tests

### Python

**`tests/test_direction_field.py`**
- **Single-vector regression:** one vector at the origin, azimuth 28°, global
  linear profile. U on the DEM matches spec 4's `PlanarUpliftModel` within
  1e-6 × the max |U| (grid discretisation, not exactness). Same for quadratic
  with hinge `none` (the guard sets the clamp).
- **Uniform field:** several vectors, all the same azimuth, give the same
  result as the single-vector case. Misfit is ≈ 0.
- **Rotating field:** vectors at the west and east ends of a synthetic basin at
  002.5° and 031° (realistic example values, not defaults). The isobases are curved (their
  normals at the two ends match the vectors within 5°), and φ is monotonic
  along a line joining the vectors. RMS misfit is < 5°.
- **Opposing vectors:** 28° vs 208° adjacent gives a degenerate-fraction
  warning.
- **Case A/B consistency:** custom tilts equal to the global profile's implied
  local values reproduce Case A within tolerance.
- **Custom asymmetry:** two vectors with the same azimuth but different custom
  gradients. U grows faster on the steeper side, and the isobases are closer
  together there.
- **Hinge in gradient form:** with the `origin` hinge (the default), U == 0
  everywhere φ < 0. With `none`, `G ≥ 0` behind the spillway (only the guard
  applies).
- **Windowed vs in-memory** equivalence with a vectors model.
- **Out-of-extent vector** warning.

**`tests/test_api_tilt_model.py`** additions:
- Every vector validation rule.
- The relaxed `tilt_azimuth`/`tilt_factor` rules and their messages.
- The diagnostics header is present.
- `/api/uplift-preview` returns isobases, with misfits per vector.

### Vitest

- CSV import: header aliases, skipped-row reporting, gradient/rate columns
  becoming custom rows, and replace vs append.
- Readiness and payload rules for vectors mode, including omitting
  `tilt_factor` when all vectors are custom.
- `utils/geometry.js`: bearing and distance helpers (compare against known
  values), and a short drag counting as a click.
- Vector state: undo stack behavior.

### Manual check

1. Place one vector at the origin, matching the Basic azimuth. The map
   isobases are straight and perpendicular to the arrow, and a run matches
   Basic's contour.
2. Add a second vector with a different azimuth: the isobases bend smoothly
   between them, and the Fit column shows small values.
3. Rotate a vector's tip handle toward the opposite direction: the misfit goes
   amber, and a warning appears.
4. Make one vector custom and steeper: the isobases bunch on its side.
5. Import a CSV with a bad row: the report lists the skipped row, and the good
   rows appear on the map.
6. Reload: vectors persist. The selection doesn't.
