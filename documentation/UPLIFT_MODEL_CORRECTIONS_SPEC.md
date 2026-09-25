# GIA Modeling Tool — Spec 4a: Uplift Model Corrections

A correction to `UPLIFT_MODEL_SPEC.md` (spec 4), applied on top of the
spec-4 implementation **before it is pushed**. It changes defaults, one
schema enum, some input options, and user-facing text. The uplift-model
interface, the refactor, and the bit-identical basic-path guarantee are
unchanged.

## Why

Two design principles were under-weighted in spec 4:

1. **The tool is location-agnostic.** It's a general-purpose model for users
   who usually *don't* have dense paleo-strandline data. Nothing in the
   defaults, UI text, placeholders, or messages may be tuned to, or point
   users toward, one paper or one set of basins. Lewis et al. (2021) informed
   the model's *form* (polynomial profiles, varying uplift directions). It is
   not a calibration source.
2. **The model is anchored at the spillway.** The strandline is contoured at
   the spillway's DEM elevation, uplift is zero there, and `tilt_factor` is
   the gradient *at the spillway*. Every parameter should be described in
   those terms.

The "natural hinge" default broke both. The vertex of a fitted quadratic
(`d = −g₀/k`) is a mathematical artifact of extending a curve beyond where
anything constrains it. It has no geological meaning, so it can't be a
default. It remains useful only as a **guard** against unphysical uplift
behind the spillway.

---

## G1. Hinge modes

### Schema (`api/tilt_model.py`)

`hinge.mode` becomes `origin | distance | none`. **Remove `natural`.** The
code hasn't been pushed, so there are no clients to stay compatible with. A
request sending `natural` gets a 422: *"hinge mode 'natural' was removed; use
'none' (the zero-gradient guard still applies)."*

| Mode | Meaning | Default |
|---|---|---|
| `origin` | No change behind the spillway | **Yes, for every family** |
| `distance` | Uplift stops changing `distance_km` behind the spillway | — |
| `none` | The profile continues behind the spillway to the DEM edge | — |

`linear` + `none` is now **valid**: the linear profile continues behind the
spillway. Remove the old `natural`+`linear` rejection and its test.

### The guard, unchanged in behavior and applied in every mode

If `g(d)` reaches zero behind the spillway *before* the mode's hinge point,
uplift is held constant from that zero onward. The math is identical to spec
4; only its framing changes. It's a guard, not a hinge choice.

- `PolynomialProfile.hinge_location(mode, distance_km)` implements:
  `origin` → 0; `distance` → `−distance_km`; `none` → `None`. It then
  applies the guard: the largest real root of `g` in `(mode's point, 0)`, if
  one exists, wins.
- **Reporting.** When the guard (rather than the mode) sets the clamp, report
  it as information, not a warning: *"The profile's gradient reaches zero X km
  behind the spillway; uplift is held constant beyond that point."*
  - In `/api/profile-preview`, return `hinge_km` plus
    `hinge_source: "mode" | "guard" | null`.
  - In `run_parameters.json`, record the same two fields.
- **Remove the warning** "natural hinge not reached within the DEM…".

### Backend default

When a caller supplies a profile without a hinge, `build_uplift_model` uses
`origin`, whatever the family. The API always receives an explicit mode from
the frontend; this only matters for direct Python callers and tests.

## G2. Quadratic curvature: second input form

Data-light users can rarely estimate a "rate of gradient increase" directly.
They can more often estimate *two gradients*: one at the spillway, and one at
some distance up the uplift direction. Support both input forms. The backend
stays canonical: the API converts to `k` so the math and
`run_parameters.json` have one representation.

### Schema: `quadratic` accepts exactly one of the two

```json
"profile": { "family": "quadratic", "rate_of_increase": 0.004 }
```
```json
"profile": { "family": "quadratic",
             "second_gradient": { "gradient_m_per_km": 1.2, "distance_km": 150 } }
```

- **Conversion:** `k = (gradient_m_per_km − tilt_factor) / distance_km`,
  computed in the API layer.
- **Validation (422):**
  - The two forms are mutually exclusive, and exactly one is required for
    `quadratic`.
  - `distance_km` must be finite and > 0.
  - `gradient_m_per_km` must be finite.
  - `second_gradient` is forbidden for `linear` and `polynomial`.
- **`run_parameters.json`** records the form the user supplied *and* the
  derived `rate_of_increase`.

### Frontend

- **State:** `advanced.profile` gains
  `curvatureInput: 'rate' | 'secondGradient'` (default `'secondGradient'`,
  the more intuitive form), `secondGradient: ''`, and
  `secondGradientDistanceKm: ''`.
- **Quadratic fields:** a two-option segmented control labelled **"Curvature
  from"**, with options **Second gradient** and **Rate of increase**.
  - *Second gradient* shows **Gradient (m/km)** and **at distance (km) up the
    uplift direction from the spillway**.
  - *Rate of increase* shows the existing rate input.
  - Values in the hidden form are kept, not cleared (spec 3 rule).
- **Readiness:** only the active form's fields are required.
- **Preview chart:** mark the second-gradient point on the curve when that
  form is active. It's a useful sanity check that the curve passes where the
  user intended.

Spec 5 (per-vector custom quadratic) must accept the same two forms. See G5.

## G3. Remove basin-specific content from user-facing code

### Audit

Across `frontend/src`, `api/`, and `backend/`, excluding `tests/` and
documentation, search for:

```
Lewis  Breckenridge  Teller  "Table 3"  Iroquois  Algonquin  Champlain  Agassiz
Whittlesey  Warren  Nipissing  Duluth  Washburn  0.647  64.94  6494  0.350
```

Handle each hit as follows:

- **User-facing strings** (labels, help text, placeholders, tooltips,
  warnings, `detail` messages, results text, `aria-label`s): remove or
  replace with the neutral text below.
- **Production constants or defaults derived from the paper:** remove. The
  profile defaults are empty fields and the `origin` hinge.
- **Code comments and docstrings:** may cite the paper as background for the
  model's *form*. They must not present its values as defaults or typical
  settings.

### Neutral replacement text

**Help text:**

| Where | Text |
|---|---|
| Gradient at spillway | Present-day slope of this shoreline's (tilted) water plane at the spillway, measured in the direction of maximum uplift. |
| Rate of increase | How much the gradient increases per km in the uplift direction. 0 gives a linear profile. |
| Second gradient | Your estimate of the gradient at a second location up the uplift direction; the curve is fitted through both. |
| Hinge | Where uplift stops changing as you move behind the spillway. |
| Polynomial coefficients | Terms of U(d) = g₀·d + c₂·d² + …, with d in km along the uplift direction from the spillway. |

**Hinge option labels:** *At spillway (default)*, *Distance behind
spillway…*, and *None: continue behind spillway*.

**Placeholders:** units only (`m/km`, `m/km per km`, `km`). No example
numbers.

**Chart:** label the zero line **"spillway"**, not "origin", in the
`ProfileChart` label and its `aria-label`. Keep "origin" in code identifiers.

### Regression guard: `tests/test_no_basin_specific_text.py`

This test scans `frontend/src/**/*.{js,jsx}` (excluding `*.test.*`) and
`api/**/*.py` for the audit terms and fails on any match. It covers the
user-facing layers only. Backend comments may legitimately cite the paper, so
`backend/` is excluded.

Keep the term list in the test file with a one-line comment explaining why.

### Test fixtures

Tests may keep realistic values such as Iroquois-like gradients and diverging
azimuths as fixtures. Rename any fixture or test whose *name* refers to a
basin to something descriptive, e.g. `concave_up_profile` or
`diverging_azimuths`. Comment that the values are realistic examples, not
defaults.

## G4. Documenting the spillway-elevation assumption

Add a short statement of the assumption to `documentation/api-README.md`
(target-elevation section) and `CLAUDE.md` (the target-elevation design
entry):

> The strandline is contoured at the spillway's **present** DEM elevation.
> This assumes the spillway sill has not been significantly eroded, incised,
> or buried since the shoreline formed, and it ignores the depth of water
> flowing over the sill (typically a few meters). Where either is significant,
> enter the target elevation manually by placing the origin off the DEM, or
> accept that offset.

Add one muted line under the target-elevation field in the Origin section, in
both modes:

> Strandlines are extracted at the spillway's present elevation, assuming the
> sill hasn't changed since the shoreline formed.

## G5. Amend the spec documents

- **`documentation/UPLIFT_MODEL_SPEC.md`:** add a banner under the title:
  *"Amended by `UPLIFT_MODEL_CORRECTIONS_SPEC.md` (spec 4a): hinge modes,
  quadratic input forms, and user-facing text. Where they conflict, 4a
  wins."* Don't rewrite the body. The banner is enough, since this doc is now
  background.
- **`documentation/VECTOR_FIELD_SPEC.md`:** add the same style of banner, plus
  two concrete edits so spec 5 isn't implemented against stale text:
  - E1 Step 5 (hinge in gradient form): replace references to the natural
    hinge with the G1 modes. `none` means only the guard applies (G ≥ 0
    behind the spillway).
  - E3 schema and E4 custom-row UI: the per-vector custom `quadratic` accepts
    either `rate_of_increase` or `second_gradient` (G2 rules). Here
    `second_gradient` is relative to the vector's own location, so
    `k_i = (gradient − local_gradient) / distance_km`.
- **`CLAUDE.md`:** update the uplift-model entry so it says the hinge default
  is `origin`, the zero-gradient point is a guard and not a hinge, and the
  tool is location-agnostic with no basin-specific defaults or text. Add that
  principle as its own short design-decision entry so future specs inherit it.

## G6. State migration

`loadCarriedForwardState` maps any persisted `advanced.hinge.mode` value of
`'default'` or `'natural'` to `'origin'`. Spec 4 was only run locally, so
this is cheap insurance, not a real migration. Remove the `'default'` value
from the frontend entirely, since the default no longer varies by family.
The payload always sends an explicit mode.

---

## Tests to update or add

**Python**
- Hinge-location tests are rewritten for `origin | distance | none`, with
  guard behavior checked in each mode, including `none` with a concave-up
  profile (clamps at the guard) and `linear` + `none` (no clamp).
- The `natural` → 422 message.
- Quadratic second-gradient conversion (a known `k`), mutual exclusion,
  forbidden-for-other-families, and `run_parameters.json` recording both
  forms.
- `/api/profile-preview` returns `hinge_source`.
- `test_no_basin_specific_text.py` (G3).
- **The bit-identical basic-path test is untouched and must still pass.**

**Vitest**
- Payload: the hinge defaults to `origin` for every family; the quadratic
  sends only the active curvature form; there's no `'default'` value anywhere.
- Readiness: only the active curvature form's fields are required.
- Migration: legacy `'default'` and `'natural'` both become `'origin'`.
- `ProfileChart`: the zero line is labelled "spillway", and the
  second-gradient marker appears when that form is active.

**Full suite** (`pytest -c setup/pytest.ini --rootdir=.`, `npm test`,
`npm run build`): passes apart from the known numpy failure.

## Manual check

1. In Advanced, pick quadratic: the hinge shows *At spillway (default)*, and
   the chart is flat behind the spillway.
2. Switch the hinge to *None* with a concave-up curvature: the chart continues
   behind the spillway until the gradient reaches zero, with the guard note
   shown.
3. Enter a second gradient at a distance: the chart marks that point, and the
   curve passes through it.
4. Check that no paper, basin name, or sample value appears anywhere in the
   UI, placeholders, or error messages.
