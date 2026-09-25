# GIA Modeling Tool — Uplift Model & Profile Families Spec

Spec 4 of the Sep 2026 feature set, and the first structural spec. It
touches the backend, API, and frontend. Implement after
`LAYOUT_AND_MODES_SPEC.md` (spec 3): this spec fills the Advanced tilt-model
section that spec 3 left as `TiltModelBody`.

Specs 5 (vector direction field) and 6 (shore-point surface) plug into the
interface defined here. Get this interface right; the other two depend on it.

## Background: why profile families

Lewis, Breckenridge & Teller (2021, *Can. J. Earth Sci.* 59: 826–846,
doi:10.1139/cjes-2021-0005) fit strandline elevation profiles "usually a
second-degree polynomial and, less commonly, a linear function". Most basins
are concave-upward. The Champlain Sea is linear.

Their Table 3 reports, per strandline:

- a southern gradient and a northern gradient (m/km);
- the distance between them (km);
- a **spatial rate of gradient increase** (m/km per km), which is
  (northern − southern) / distance.

That rate is exactly the curvature term of a quadratic. So the families are
parameterized in the paper's own terms, and users can enter published values
directly. For example, Iroquois West is gradient 0.350 m/km and rate
64.94×10⁻⁴ m/km per km.

## Goal

1. Refactor the tilt math so the per-pixel elevation change comes from a
   pluggable **uplift model**, not hard-coded linear-planar arithmetic.
2. Ship three profile families (linear, quadratic, polynomial up to degree 5)
   and three hinge rules, all driven by a new optional `tilt_model` JSON
   field on `/api/process`.
3. **Basic mode output stays bit-identical** to today's, proven by tests.
4. In Advanced mode, users pick a family, enter its parameters, choose a
   hinge rule, and see an uplift-vs-distance preview chart before running.
5. Every run's zip bundle gains a `run_parameters.json` for reproducibility.

## Out of scope

- Non-planar directions: vectors (spec 5) and shore-point surfaces (spec 6).
- Exponential or other families. The registry makes them easy to add later.

---

## D1. The model: one number per pixel

The math is expressed as **uplift relative to the origin**, `U`, in meters.
The tilted DEM is `DEM − U`. `U(origin) = 0` always holds, which keeps the
DEM-authoritative target-elevation logic valid.

For the planar direction used here, each pixel has a signed distance `d` (km)
along the tilt azimuth from the origin's isobase. This is the existing
`projected_distance_km`, *before* clamping. `d > 0` is up-tilt; `d < 0` is
behind the spillway.

### Profiles: `U(d) = Σₖ cₖ·dᵏ`, k = 1…n, no constant term

The constant term is absent by construction, so `U(0) = 0` always holds. `c₁`
is **always the gradient at the origin (m/km)**, and it is always the existing
`tilt_factor` field. There is one source of truth; see spec 3 C2 for the
shared-state mapping.

| Family | Parameters (beyond `tilt_factor`) | Coefficients |
|---|---|---|
| `linear` | none | `c₁ = tilt_factor` |
| `quadratic` | `rate_of_increase` *k* (m/km per km) | `c₁ = tilt_factor`, `c₂ = k/2` |
| `polynomial` | `coefficients: [c₂ … cₙ]`, 1–4 values (degree 2–5) | `c₁ = tilt_factor`, rest as given (units m/kmᵏ) |

The local gradient is `g(d) = U′(d) = Σₖ k·cₖ·dᵏ⁻¹`. For a quadratic, that's
`g(d) = tilt_factor + k·d`, which is the paper's model exactly.

### Hinge rules (behind the origin, d < 0)

Each rule defines where uplift stops changing as you move behind the spillway.
Past that point, `U` is held constant at its value there.

| `hinge.mode` | Hinge location `d_h` | Default for |
|---|---|---|
| `origin` | `0`: no change behind the spillway (today's behavior) | `linear` |
| `distance` | `−hinge.distance_km` (> 0) | — |
| `natural` | the first zero of `g(d)` behind the origin, i.e. the largest real root of `g` in (−∞, 0) | `quadratic`, `polynomial` |

Evaluation is `U(max(d, d_h))`.

**Monotonicity guard, applied in every mode.** If `g` reaches zero behind the
origin *before* `d_h`, clamp at that zero instead. Uplift must never start
increasing again as you move away behind the spillway; that's the unphysical
turn-around of a concave-upward quadratic past its vertex.

- **`natural` with no root:** the profile continues to the DEM edge. Emit a
  `UserWarning`: "natural hinge not reached within the DEM; profile applied
  unclamped behind the origin".
- **`natural` with `linear`:** a validation error, because `g` is constant
  and has no zero. The UI never offers this combination.

Compute `d_h` **once**, when the model is built, not per block: take the
polynomial roots of `g` with `numpy.roots`, keep the real roots (imaginary
part < 1e-9) that are < 0, and choose the largest.

Example: Iroquois West's natural hinge is at `d = −0.350/0.006494 ≈ −54 km`.

**No forward guard.** For `d > 0` the profile applies as given. If `g` changes
sign within the DEM's forward distance range (a concave-down profile), emit a
`UserWarning` naming the distance where it happens. That shape is unusual but
not wrong.

## D2. Backend structure

### New module `backend/uplift.py`

```python
class UpliftModel:  # protocol; plain duck typing is fine
    extra_bytes_per_pixel: int          # added to TILT_BYTES_PER_PIXEL (D3)
    def evaluate(self, east_km, north_km):  # arrays, broadcastable -> uplift U (m), float64
        ...

@dataclass(frozen=True)
class PolynomialProfile:
    coeffs: tuple            # (c1, ..., cn), n >= 1
    def U(self, d): ...      # Horner, no constant term
    def g(self, d): ...      # derivative
    def hinge_location(self, mode, distance_km=None) -> float | None: ...  # D1 rules + guard

@dataclass(frozen=True)
class PlanarUpliftModel(UpliftModel):
    azimuth_deg: float
    profile: PolynomialProfile
    hinge_d: float | None    # resolved once at build time; None = unclamped
    def evaluate(self, east_km, north_km):
        rad = np.radians(self.azimuth_deg)
        d = east_km * np.sin(rad) + north_km * np.cos(rad)
        if self.hinge_d is not None:
            d = np.where(d < self.hinge_d, self.hinge_d, d)
        return self.profile.U(d)

def build_uplift_model(spec: dict, tilt_azimuth, tilt_factor) -> UpliftModel: ...
def linear_planar_model(tilt_azimuth, tilt_factor) -> PlanarUpliftModel: ...  # basic mode
```

`build_uplift_model` takes the already-validated plain dict from the API
layer (D4). Pydantic stays in `api/`. The backend has no FastAPI or Pydantic
imports, consistent with the existing split.

### Bit-identical basic path

Today's code does exactly this:

```python
projected_distance_km = np.where(projected_distance_km < 0, 0, projected_distance_km)
elevation_delta = projected_distance_km * tilt_factor
return block - elevation_delta
```

`linear_planar_model` with `hinge_d = 0.0` must reproduce it **bit for bit**:

- The same projection expression, in the same operand order:
  `east_km * np.sin(rad) + north_km * np.cos(rad)`.
- The same clamp: `np.where(d < 0.0, 0.0, d)` is identical to today's for
  `hinge_d == 0.0`.
- For `coeffs == (c1,)`, `profile.U(d)` must compute `d * c1` directly, not a
  Horner loop that starts from `0.0 + …`. That would still be exact, but make
  the single-term case a literal multiply so the equivalence is obvious.

Assert it with `np.array_equal` (D7). Not `allclose`.

### Refactor of `backend/main.py`

1. **Extract the local-frame math from `_tilt_block`** into a reusable
   function. Specs 5 and 6 need the identical frame, so build isobases,
   vectors, and shore points in it, not a separately derived projection.

   ```python
   def _local_en_km(lons, lats, origin_coords, diagonal_km, geod):
       """(east_km, north_km) of lon/lat arrays relative to the origin, using exactly
       the calibrated flat-plane scheme _tilt_block uses today (single calibration
       below RECALIBRATION_THRESHOLD_KM, per-row cos-latitude correction above).
       Same arithmetic, same order."""
   ```

   Also add its exact inverse, `_local_en_to_lonlat(east_km, north_km, origin_coords, diagonal_km, geod)`.
   With the per-row correction, the inverse is: recover the latitude first
   from `north_km`, then the longitude with that latitude's scale factor. Test
   the round trip (D7).

2. **`_tilt_block`** becomes: compute `lons, lats` → call `_local_en_km` →
   `U = uplift_model.evaluate(east_km, north_km)` → `return block - U`.
   Preserve the existing comments about calibration and banding; move them
   with the code they describe.

3. **`calculate_tilt`, `tilt_DEM_windowed`, and `process_dem`** gain a keyword
   argument `uplift_model=None`, and keep every current parameter:
   - When it's `None`, they build `linear_planar_model(tilt_azimuth, tilt_factor)`
     internally, so every existing caller and test keeps working unchanged.
   - When it's given, it takes precedence, and `tilt_azimuth`/`tilt_factor`
     are ignored by the math. Say so in the docstrings.
   - `tilt_DEM_windowed` passes the same model object to every block.

   Hinge resolution already happened at build time, so the per-block work is
   purely elementwise and needs no global context. Windowed and in-memory runs
   therefore agree (tested in D7).

## D3. Memory estimate

Horner evaluation of a degree-n polynomial holds about two float64
temporaries beyond today's pipeline.

- **Linear:** `extra_bytes_per_pixel = 0`.
- **Degree ≥ 2:** `16`.

In `process_dem`, size the tilt tiles and chunks with
`TILT_BYTES_PER_PIXEL + uplift_model.extra_bytes_per_pixel`. Add a comment
matching the existing "estimated, not profiled" notes.

## D4. API

### `tilt_model` form field on `POST /api/process`

This is an optional JSON string. When it's absent, the run is today's basic
run.

```json
{
  "version": 1,
  "direction": { "type": "azimuth" },
  "profile": {
    "family": "quadratic",
    "rate_of_increase": 0.006494,
    "coefficients": null
  },
  "hinge": { "mode": "natural", "distance_km": null }
}
```

`tilt_azimuth` and `tilt_factor` stay required form fields. `tilt_factor` is
`c₁`. Spec 5 relaxes `tilt_azimuth` for non-azimuth directions.

### New file `api/tilt_model.py`

This holds the Pydantic models for the schema above, plus
`parse_tilt_model(raw: str) -> dict`. Validation rules, each returning a 422
with a specific `detail`:

- **JSON and version:** malformed JSON is rejected, and `version` must be `1`.
- **Direction:** `direction.type` must be `"azimuth"`. Specs 5 and 6 add types
  to this union.
- **Family parameters:**
  - `quadratic` requires a finite `rate_of_increase` and forbids
    `coefficients`.
  - `polynomial` requires 1–4 finite `coefficients` and forbids
    `rate_of_increase`.
  - `linear` forbids both.
- **Hinge:**
  - `mode` must be one of `origin | distance | natural`.
  - `distance` requires `distance_km > 0` and finite; the other modes forbid
    `distance_km`.
  - `natural` with `linear` is rejected (the D1 message).
- **Unknown keys** are rejected (`extra="forbid"`), so a typo never silently
  becomes a default.

In `process()`, parse `tilt_model` in the up-front validation block, before
touching disk. Then call
`build_uplift_model(parsed, tilt_azimuth, tilt_factor)` and pass the result
into `process_dem(..., uplift_model=model)`.

### New endpoint `POST /api/profile-preview`

This takes a JSON body and does no raster I/O, so it's cheap.

```json
{
  "tilt_azimuth": 28, "tilt_factor": 0.35, "tilt_model": { ...same schema... },
  "origin": [lon, lat],
  "bounds_wgs84": [west, south, east, north],
  "samples": 121
}
```

It returns:

```json
{
  "d_km":     [...],              // evenly spaced over the DEM's d-range
  "uplift_m": [...],              // U(d) with hinge applied
  "gradient_m_per_km": [...],     // g(d), zero where clamped
  "d_range_km": [dmin, dmax],     // the four bbox corners projected onto the azimuth
  "hinge_km": -54.0 | null,
  "warnings": ["..."]             // the same UserWarnings the run would emit
}
```

- **d-range:** compute it by converting the four `bounds_wgs84` corners with
  `_local_en_km` (the same frame as the run) and projecting them onto the
  azimuth.
- **Missing inputs:** if `origin` or `bounds` is absent, fall back to
  `[-100, 100]` km and add a warning saying the range is nominal.
- **Validation:** use the same Pydantic models and messages as `/process`.

### Zip bundle: `run_parameters.json`

Add this file to `/api/process`'s zip in every mode, including basic. It
records:

- `schema_version`, the app's git commit if cheaply available (else null),
  and a UTC timestamp;
- the input file name (not a full server path, which could be a private pod
  path);
- the resolved origin (lon, lat), `effective_target_elevation` and its source
  (`dem`/`manual`), `tilt_azimuth`, `tilt_factor`, and the parsed `tilt_model`
  (or `null`);
- `include_dem`, `selection_radius_km`, and whether the input was reprojected
  and from what.

Document it in `api-README.md`'s bundle section. The frontend doesn't need to
read it.

## D5. Frontend

### State (in spec 3's `advanced` namespace)

```js
advanced: {
  ...,
  profile: { family: 'linear', rateOfIncrease: '', coefficients: ['', '', '', ''], degree: 3 },
  hinge:   { mode: 'default', distanceKm: '' },   // 'default' = family default (D1 table)
}
```

- `tiltFactor` (shared, top level) is the gradient at the origin in every
  family.
- `degree` controls how many `coefficients` inputs show (c₂…c_degree).
  Changing it never erases values typed into slots that become hidden.
- Profile-preview responses are transient: keep them out of persistence (spec
  3 C2 rule 2).

### Tilt model section (`TiltModelBody`)

The layout follows canvas artboard B's global-profile block:

- **Direction:** a "Single azimuth" label plus the shared `tiltAzimuth` input.
  Spec 5 replaces this row with the direction-source switch.
- **Profile family:** a `<select>` with Linear, Quadratic, and Polynomial.
- **Gradient at origin (m/km):** the shared `tiltFactor`.
- **Family-specific fields:**
  - Quadratic: **Rate of gradient increase (m/km per km)**. Accept `e`
    notation (`64.94e-4`); use a text input with numeric validation, not
    `type="number"`, which mangles exponents in some browsers.
  - Polynomial: a degree selector (2–5) and coefficient inputs labelled
    **c₂ (m/km²)** through **cₙ**.
- **Hinge behind origin:** a `<select>` whose first option reads
  `Default (at origin)` for linear, or `Default (natural, zero gradient)`
  otherwise. The other options are `At origin`, `Distance behind origin…`
  (which reveals a km input), and `Natural` (hidden for linear).
- **Help line** under the family fields: *"Lewis et al. (2021), Table 3, lists
  southern gradients and rates of gradient increase for major Laurentide
  strandlines."* Keep it to one line with no link, since this is an offline
  lab tool.

### Profile preview chart

`components/advanced/ProfileChart.jsx` is a small hand-rolled SVG with no new
charting dependency.

- **Content:** uplift (m) vs distance along the azimuth (km) over the
  returned `d_km` range; a vertical line at `d = 0` labelled "origin"; a
  marker at `hinge_km`; and the flat clamped segment drawn dashed.
- **Axes:** two, with 4–5 ticks each from a small `niceTicks` helper
  (`utils/ticks.js`, unit-tested).
- **Sizing:** about 440×160px, fitting the form column's width.
- **Accessibility:** an `aria-label` summarizing the curve, e.g. "Uplift from
  −20 m at −54 km (hinge) to 310 m at 180 km".
- **Warnings:** returned warnings render beneath it in the same warning style
  as the results screen.
- **Fetching:** request `/api/profile-preview` debounced (400ms) whenever the
  azimuth, tilt factor, family, parameters, hinge, resolved origin, or bounds
  change, and only when the local inputs pass readiness for the tilt section.
  Add `profilePreview(...)` to `api/client.js`, with the relative path per
  `CLAUDE.md`.
- **Stale responses:** ignore a response if newer inputs were requested (a
  request counter), the same pattern the coordinate checks use.

### Readiness (`utils/readiness.js`, advanced branch)

These checks apply in Advanced mode only (spec 3 C6). All reasons are keyed to
the `tilt` section.

- Quadratic requires a finite `rateOfIncrease`.
- Polynomial requires c₂…c_degree to all be finite.
- A `distance` hinge requires `distanceKm > 0`.

### Payload (`utils/payload.js`, advanced branch)

Serialize `tilt_model` from `advanced` per the D4 schema:

- Resolve `hinge.mode: 'default'` to the family's default before sending. The
  server never sees `'default'`.
- Send `coefficients` only for polynomial, sliced to the chosen degree, as
  numbers.
- Basic mode never sends `tilt_model`.

### Results screen

In advanced mode, the parameter line in `ResultsSuccess` adds the family and
hinge, e.g. `· Quadratic, k = 64.94e-4 · hinge natural (−54 km)`.

---

## Files touched

- **Backend:** `backend/uplift.py` (new); `backend/main.py` (`_local_en_km`
  and its inverse, `_tilt_block`, `calculate_tilt`, `tilt_DEM_windowed`);
  `backend/app.py` (`uplift_model` kwarg, memory sizing).
- **API:** `api/tilt_model.py` (new); `api/main.py` (`tilt_model` field,
  `/api/profile-preview`, `run_parameters.json`).
- **Frontend:** `api/client.js`; `context/ProcessingContext.jsx` (defaults);
  `components/forms/AdvancedForm.jsx` / `TiltModelBody`;
  `components/advanced/ProfileChart.jsx` (new); `utils/ticks.js` (new);
  `utils/readiness.js`; `utils/payload.js`; `ResultsSuccess.jsx`.
- **Docs:**
  - `documentation/api-README.md`: the `tilt_model` schema and error
    messages, `/api/profile-preview`, and `run_parameters.json`.
  - `CLAUDE.md`: a new design-decision entry covering the uplift-model
    interface (`evaluate(east_km, north_km) → U`), "`tilt_factor` is always
    c₁", the hinge rules and monotonicity guard, `_local_en_km` as the single
    shared frame, and the bit-identical basic-path guarantee. Also update the
    `calculate_tilt` entry so its description matches the refactor.

## D7. Tests

### Python (`pytest -c setup/pytest.ini --rootdir=.`)

**`tests/test_uplift_profiles.py`**
- `U(0) == 0` for all families.
- `g` matches a numerical derivative.
- Quadratic built from (g₀, k) gives `g(d) = g₀ + k·d`.
- Natural hinge for Iroquois West values ≈ −53.9 km.
- A polynomial with no negative root means `hinge_location('natural')` is
  `None`, plus the warning.
- A `distance` hinge beyond a natural zero clamps at the natural zero (the
  guard).
- `linear` + `natural` raises.
- Coefficients with complex roots are ignored correctly.

**`tests/test_local_frame.py`**
- The `_local_en_km` round trip through `_local_en_to_lonlat` is within 1e-9
  degrees, both below and above `RECALIBRATION_THRESHOLD_KM` (reuse the
  synthetic 423 km grid idea from `PERFORMANCE_OPTIMIZATION_SPEC.md`).

**Regression, the non-negotiable one**
- Refactored `calculate_tilt` with no `uplift_model` is `np.array_equal` to a
  frozen copy of today's `_tilt_block` output. Before refactoring, copy the
  current `_tilt_block` verbatim into the test file as `_legacy_tilt_block`.
- Check this on the existing synthetic fixtures, both with and without
  `chunk_rows`, and for diagonals below and above the recalibration threshold.

**Equivalence**
- Windowed and in-memory pipelines agree for a quadratic model with a natural
  hinge, extending `test_pipeline_equivalence.py`'s pattern.

**`tests/test_api_tilt_model.py`**
- Every validation rule in D4 returns 422 with its message.
- A valid quadratic run returns 200.
- `run_parameters.json` is present and contains the parsed model.
- Basic runs have `"tilt_model": null`.
- A `/api/profile-preview` happy path, the nominal-range fallback, and hinge
  and warnings passthrough.

**Existing tests**
- All pass unchanged, except the known numpy-version failure.

### Vitest

- `utils/payload.js`: `'default'` hinge resolution per family, polynomial
  coefficient slicing, and no `tilt_model` in basic mode.
- `utils/readiness.js`: each new advanced rule, and that Basic readiness
  ignores `advanced.profile` entirely.
- `utils/ticks.js`: nice tick values for representative ranges, including
  negative-to-positive ranges.
- `ProfileChart`: renders the hinge marker when `hinge_km` is present, and
  `aria-label` content.

### Manual check

1. In Basic, run a known DEM and save the output. Switch to Advanced (linear,
   default hinge) and run again: the GeoPackages' contour geometries are
   identical.
2. Set quadratic with Iroquois West values: the chart shows a concave-up curve
   with the hinge near −54 km, and the run's contour shifts accordingly.
3. Try linear with a distance hinge of 30 km: the chart's dashed flat segment
   starts at −30 km.
4. Enter a malformed rate (`abc`): the Run button lists the reason, and no
   preview request fires.
