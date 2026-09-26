# API layer

`POST /api/process` wraps `app.process_dem` as an HTTP endpoint: upload a DEM
GeoTIFF, describe the tilt origin and parameters, get back a zip bundle
containing the strandline contour `.gpkg` (and optionally the tilted DEM),
plus the small preview artifacts the frontend's map panel renders (see
"Response bundle" below).

Routes are namespaced under `/api` (`/api/process`, `/api/preflight`,
`/api/resolve-point`, `/api/raster-preview`, `/api/origin-elevation`,
`/api/profile-preview`, `/api/uplift-preview`, `/api/fit-uplift-surface`, `/api/health`) so the frontend's relative `api/...` fetches (required for
`jupyter-server-proxy` compatibility, see `CLAUDE.md`) resolve correctly with
no path rewriting needed in either the Vite dev proxy or production.

## `POST /api/process` response bundle

The response body is a zip archive (`Content-Type: application/zip`), not a
bare `.gpkg` file:

```
strandlines.gpkg    -- unchanged: the same GeoPackage this endpoint always
                       produced (strandline contour vector layer, plus the
                       tilted DEM raster layer when include_dem is true)
contour.geojson     -- the strandline_contour layer, read back from the
                       .gpkg and dumped to GeoJSON (already EPSG:4326,
                       since the working raster process_dem tilts is
                       always reprojected to WGS84 first -- see
                       api/crs.py)
preview_tilted.tif  -- present only when include_dem is true. A small,
                       decimated GeoTIFF read back from the .gpkg's
                       raster table (see api/raster_preview.py), for the
                       frontend's map panel -- not a second run of the
                       tilt/contour pipeline, just a cheap read of
                       already-computed output.
run_parameters.json -- always present, in every mode: what this run used,
                       for reproducibility (see "run_parameters.json" below)
shore_points.csv    -- present only for a `points` run (spec 6): the points that
                       were fitted (lat, lon, elevation_m, label, residual_m),
                       so the bundle alone reproduces the run. Re-importable:
                       its headers are ones the frontend importer matches.
```

`contour.geojson`/`preview_tilted.tif` exist purely to feed the frontend
map panel's result-preview state (see `VISUALIZATION_PIPELINE_SPEC.md`);
the `.gpkg` inside the zip is byte-identical to what this endpoint returned
before this bundling was added, so the existing download flow is
unaffected. All the response headers described below (`X-Source-CRS-...`,
`X-Processing-Warnings`, `X-Target-Elevation-...`) are unchanged and attach
to this same zip response.

## `POST /api/preflight`

Cheap, metadata-only companion to `/api/process` — reuses `raster_io_check`
without running reprojection, origin resolution, or the geoprocessing
pipeline. Meant to fire on file drop or path entry/blur.

**Request** — multipart form, exactly one of `dem_file` (file upload) or
`file_path` (string, server-side path). Both present or both absent → `422`.

**Response:**
```json
{
  "crs": "EPSG:32612",
  "bounds_wgs84": [-110.62, 45.18, -110.48, 45.31],
  "diagonal_km": 12.3,
  "band_count": 1,
  "use_windowed_io": false,
  "needs_casting": false,
  "peak_ram_mb": 812.4
}
```
`bounds_wgs84` is `[west, south, east, north]` in degrees -- the raster's own
extent reprojected to EPSG:4326 (via `get_raster_bounds_wgs84`, the same
helper `/api/process` uses), for the frontend's map panel to draw the input
extent and `fitBounds` to it before any raster pixels have loaded.

`diagonal_km` is the raster's own corner-to-corner geodesic distance (via
`get_raster_diagonal_km`, reprojection-aware the same way `bounds_wgs84` is),
informational only -- it mirrors the routing decision `calculate_tilt` makes
internally on the backend to decide between a single-point flat-plane
calibration and a large-extent (latitude-corrected) one, recomputed
independently once the raster is guaranteed WGS84 rather than trusted from
this pre-reprojection value. See
`documentation/PERFORMANCE_OPTIMIZATION_SPEC.md` Fix 1c.

`peak_ram_mb` also no longer implicitly under-counts `calculate_tilt`'s own
memory cost the way it used to -- see `PERFORMANCE_OPTIMIZATION_SPEC.md`'s
"core problem" section. `use_windowed_io`'s routing decision is unchanged by
that fix (it's still driven purely by the raw array + cast, same as before);
what changed is that the in-memory branch is no longer at risk of blowing far
past this estimate once it's actually running.

## `POST /api/resolve-point`

Cheap coordinate resolution, no file I/O -- wraps the same origin-parsing
functions `/api/process` uses (`parse_xy_pair` /
`parse_decimal_degrees_hemisphere` / `normalize_origin_to_wgs84` in
`api/crs.py`) for a live map preview, called on every coordinate-field blur.
Deliberately not built on `/api/origin-elevation`, which reprojects the
entire raster just to sample one point -- too expensive to fire that often.

**Request** -- JSON body, not multipart (the only endpoint that isn't):
```json
{
  "origin_mode": "match_raster",
  "origin_value": "512300,5023100",
  "origin_epsg": null,
  "native_crs": "EPSG:32612"
}
```
`native_crs` is required only for `match_raster` mode, and is expected to
come from `/api/preflight`'s `crs` field, cached client-side -- no raster
re-read needed. For `decimal_degrees` and `epsg` modes this is a pure
string-parse + `pyproj` point transform; `native_crs` is ignored.

**Response:**
```json
{ "lon": -110.55, "lat": 45.25 }
```
`422` on parse failure, or a missing `origin_epsg`/`native_crs` where the
given `origin_mode` requires one -- same taxonomy as the other
origin-handling endpoints. There is no 500m plausibility check here (see
"Plausibility check" below) -- that's only meaningful once a raster is
involved, and this endpoint deliberately isn't.

## `POST /api/raster-preview`

Same dual file-resolution as `/api/preflight` (`dem_file`/`file_path`).
Returns a small, decimated, EPSG:4326 GeoTIFF (`Content-Type: image/tiff`)
of the uploaded/pathed DEM, for the map panel to draw as soon as the file is
known-good -- fires once, right after `/api/preflight` succeeds, not on
every keystroke.

Built by `api/raster_preview.py::build_preview_geotiff_bytes`: decimates the
raster at native resolution first (`rasterio`'s `out_shape`, cheap
regardless of source file size), then reprojects only that small decimated
array to EPSG:4326 if it isn't already. The same helper builds
`/api/process`'s bundled `preview_tilted.tif` (see above), reading from the
`.gpkg` raster table instead of the raw upload.

`PREVIEW_MAX_DIM` (in `api/raster_preview.py`) caps the longer dimension at
1024px -- a starting value suggested directly in
`VISUALIZATION_PIPELINE_SPEC.md`, not yet tuned against a real CryoCloud
pod's memory/latency profile.

Errors match `/api/preflight`: `422` for an unsupported extension or an
undefined/unrecognized CRS, `400` for a missing/corrupted file.

## `POST /api/origin-elevation`

Preview-only companion to `/api/process` — reports the DEM's own elevation
at the resolved tilt origin, using the same sampling `/api/process` uses to
authoritatively override `target_elevation` (see "Target elevation
resolution" below). Lets a client show the value, or explain why it can't be
determined, before running the full (potentially multi-minute) pipeline.
`/api/process` never trusts this endpoint's output — it re-derives
everything independently, so calling this first is optional and purely a UX
convenience.

**Request** — multipart form, same file-resolution duality as
`/api/preflight` (exactly one of `dem_file` / `file_path`), plus the same
origin fields `/api/process` takes: `origin_mode`, `origin_value`,
`origin_epsg` (see "Origin modes" below).

Because it samples against the same reprojected working raster
`/api/process` actually tilts (not the raw uploaded/pathed file), this
endpoint pays the same reprojection cost `/api/process` would for a
non-EPSG:4326 input — unavoidable if the preview is to actually agree with
the real run.

**Response:**
```json
{ "within_bounds": true, "elevation": 812.4, "reason": null }
```
```json
{ "within_bounds": false, "elevation": null, "reason": "outside_bounds" }
```
```json
{ "within_bounds": true, "elevation": null, "reason": "nodata" }
```

`within_bounds` is a strict inside/outside test against the raster's own
grid — not the 500m plausibility threshold described under "Plausibility
check" below. A point can pass that 500m check and still be genuinely
outside the raster, which is `reason: "outside_bounds"` here.

Error taxonomy matches `/api/preflight`: `422` for input-shape/origin
validation, `400` for missing file / corrupted raster.

Run locally from the repository root:
```bash
uvicorn api.main:app --reload
```
Interactive docs (request/response schema, try-it-out) are served at `/docs`.

## Request fields

| field | type | required | notes |
|---|---|---|---|
| `dem_file` | file | exactly one of `dem_file` / `file_path` | GeoTIFF, `.tif`/`.tiff` |
| `file_path` | string | exactly one of `dem_file` / `file_path` | server-side path, same pod filesystem |
| `origin_mode` | string | yes | one of `"match_raster"`, `"decimal_degrees"`, `"epsg"` |
| `origin_value` | string | yes | format depends on `origin_mode` -- see below |
| `origin_epsg` | string | only if `origin_mode == "epsg"` | e.g. `"EPSG:32612"` |
| `tilt_azimuth` | float | yes, unless `tilt_model.direction.type` is `"vectors"` or `"points"` | tilt direction, degrees |
| `tilt_factor` | float | yes, unless `direction.type` is `"points"`, or `"vectors"` with every vector custom | meters of elevation change per km, at the spillway -- see "Relaxed fields" below |
| `target_elevation` | float | yes | paleo-elevation to contour, meters -- may be overridden server-side, see "Target elevation resolution" below |
| `include_dem` | bool | no (default `true`) | also embed the tilted DEM as a raster layer |
| `selection_radius_km` | float | no | keep only strandline contours that come within this many km of the resolved origin -- see "Selection radius" below |
| `tilt_model` | string (JSON) | no | uplift model: profile family + hinge rule -- see "Tilt model" below. Absent means the basic linear tilt (byte-identical to a run before this field existed), which requires `tilt_azimuth` and `tilt_factor`; `tilt_factor` is always the global profile's gradient at the origin (c1) |

## Tilt model

`tilt_model` is an optional JSON string (a multipart form field). The tilted DEM
is `DEM - U`, where `U(d)` is the uplift in meters at signed distance `d` (km)
along `tilt_azimuth` from the spillway's isobase (`d > 0` is up-tilt). The model
is anchored at the spillway: the strandline is contoured at the spillway's DEM
elevation, `U(0) = 0` always holds, and `tilt_factor` is the gradient *at the
spillway*. Profiles are polynomials with no constant term, `U(d) = sum_k c_k d^k`
(`c1 = tilt_factor`). The tool is location-agnostic: it has no built-in
parameters for any particular basin, and the profile defaults are empty fields
and the `origin` hinge.

```json
{
  "version": 1,
  "direction": { "type": "azimuth" },
  "profile": { "family": "quadratic", "rate_of_increase": 0.004 },
  "hinge": { "mode": "origin", "distance_km": null }
}
```

| family | parameters | coefficients |
|---|---|---|
| `linear` | none | `c1 = tilt_factor` |
| `quadratic` | exactly one of `rate_of_increase` *k* (m/km per km) or `second_gradient` | `c1 = tilt_factor`, `c2 = k/2`, so the local gradient is `tilt_factor + k*d` |
| `polynomial` | `coefficients: [c2 ... cn]`, 1-4 values (degree 2-5), units m/km^k | `c1 = tilt_factor`, the rest as given |

**Quadratic curvature, two input forms.** Data-light users can rarely estimate a
rate of increase directly, but can often estimate the gradient at a second
location up the uplift direction. `quadratic` therefore accepts either
`"rate_of_increase": 0.004` or
`"second_gradient": { "gradient_m_per_km": 1.2, "distance_km": 150 }` (mutually
exclusive; exactly one is required). The API converts a second gradient to the
canonical rate, `k = (gradient_m_per_km - tilt_factor) / distance_km`, so the
math has one representation. `run_parameters.json` records the form the user
supplied *and* the derived `rate_of_increase`.

**Hinge** (behind the spillway, `d < 0`): where uplift stops changing. Evaluation
is `U(max(d, d_h))`.

| `hinge.mode` | meaning | default |
|---|---|---|
| `origin` | no change behind the spillway | **yes, for every family** |
| `distance` | uplift stops changing `distance_km` behind the spillway (`d_h = -distance_km`) | -- |
| `none` | the profile continues behind the spillway to the DEM edge | -- |

`hinge` may be omitted, which means `origin`. `linear` + `none` is valid (the
linear profile continues). The mode `natural`, from an earlier draft, was removed
and returns a `422`.

**The zero-gradient guard** applies in every mode: if the profile's gradient
reaches zero behind the spillway *before* the mode's own point (the largest real
root of the gradient in `(mode's point, 0)`), uplift is held constant from that
zero instead, so it never starts increasing again as you move away behind the
spillway. It is a guard, not a hinge choice, and it is reported as information,
not as a warning: *"The profile's gradient reaches zero X km behind the
spillway; uplift is held constant beyond that point."* `hinge_source` says what
set the clamp: `"mode"` (the hinge mode's own point), `"guard"`, or `null` (an
unclamped profile). There is no forward guard; a gradient sign change within the
DEM's up-tilt range only produces a warning (in `X-Processing-Warnings`, and in
`/api/profile-preview`'s `warnings`): *"The profile's gradient changes sign about
N km up-tilt of the origin (a concave-down profile); the profile is applied as
given."*

**Validation** (all `422`, with these `detail` messages; unknown keys are
rejected, so a typo never silently becomes a default):

| rule | `detail` |
|---|---|
| malformed JSON | `tilt_model must be valid JSON: ...` |
| not an object | `tilt_model must be a JSON object.` |
| `version` not `1` | `tilt_model.version must be 1.` |
| unknown `direction.type` | `tilt_model.direction.type must be one of ['azimuth', 'vectors', 'points'].` |
| unknown key | `tilt_model has an unknown key: '<path>'.` |
| missing required object/field | `tilt_model.<path> is required.` |
| unknown family | `tilt_model.profile.family must be one of ['linear', 'quadratic', 'polynomial'].` |
| quadratic with both forms | `A quadratic profile takes either rate_of_increase or second_gradient, not both.` |
| quadratic with neither | `A quadratic profile requires rate_of_increase or second_gradient.` |
| quadratic rate not finite | `A quadratic profile requires a finite rate_of_increase.` |
| quadratic with `coefficients` | `A quadratic profile does not take coefficients.` |
| `second_gradient.distance_km` not finite and > 0 | `second_gradient.distance_km must be finite and > 0.` |
| `second_gradient.gradient_m_per_km` not finite | `second_gradient.gradient_m_per_km must be finite.` |
| polynomial without 1-4 finite coefficients | `A polynomial profile requires 1 to 4 finite coefficients (c2 to c5).` |
| polynomial with `rate_of_increase` / `second_gradient` | `A polynomial profile does not take rate_of_increase.` / `... second_gradient.` |
| linear with any of the three | `A linear profile takes none of rate_of_increase, second_gradient or coefficients.` |
| hinge mode `natural` | `hinge mode 'natural' was removed; use 'none' (the zero-gradient guard still applies).` |
| unknown hinge mode | `tilt_model.hinge.mode must be one of ['origin', 'distance', 'none'].` |
| `distance` without `distance_km > 0` | `A 'distance' hinge requires distance_km > 0 and finite.` |
| `distance_km` on another mode | `A '<mode>' hinge does not take distance_km.` |
| non-finite `tilt_azimuth` / `tilt_factor` alongside `tilt_model` | `tilt_azimuth and tilt_factor must be finite numbers.` |
| `vectors` rules | see "Vector direction field" below |
| `points` rules | see "Shore-point surface" below |

An `azimuth` (or absent) model is parsed and built before the upload is written
to disk, so a bad model fails fast. A `vectors` model is *validated* at the same
point but *built* once the working raster exists (it needs the raster's
geometry), still before any tilt work.

## Vector direction field (`direction.type == "vectors"`)

Multi-directional tilt for shorelines with too little data to fit a surface. The
user supplies vectors -- a location, an azimuth (the direction of maximum uplift
there) and an optional **range** -- and the tool builds a smooth uplift surface
whose isobases bend to follow them. **Range is the vector's range of influence
(how far its direction is trusted), never a magnitude.** Magnitude comes from the
global profile (`tilt_factor`, `profile`, `hinge`), or per vector from a custom
tilt.

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

**Custom tilts** (`custom`, per vector; `null` = use the global profile). Only
`linear` and `quadratic` (polynomials are global-only). `local_gradient` is the
gradient **at that vector's own location** (custom gradients are *local*). A
`quadratic` takes exactly one of `rate_of_increase` *k* or `second_gradient`, the
latter *relative to the vector's own location*: `k = (gradient_m_per_km -
local_gradient) / distance_km`, `distance_km` measured up the uplift direction
from the vector. As for the global profile, the backend is canonical in *k*;
`run_parameters.json` records the form supplied and the derived
`rate_of_increase`.

**The method** (all in the same local frame as the tilt, `_local_en_km`; see
`backend/direction_field.py`): a working grid (at most 256 cells on the long side,
DEM bounds plus 5% padding) blends the vectors' unit directions with weights
`taper(r/R) / (r^2 + h^2)`, solves in least squares for a curved distance
coordinate `phi` with `grad(phi) ~ direction` (its contours are the isobases),
and then either applies the global profile to `phi` (every vector uses it) or
integrates a blended gradient field (some vector is custom). A single vector
with the global profile reproduces the planar azimuth model. Windowed and
in-memory runs use the same model object and agree.

**Validation** (`422`, `detail` names the vector by its 1-based row number):

| rule | `detail` |
|---|---|
| not 1-200 vectors | `tilt_model.direction.vectors must contain 1 to 200 vectors.` |
| `vectors` missing / present for `azimuth` | `tilt_model.direction.vectors is required when direction.type is 'vectors'.` / `... is only allowed when direction.type is 'vectors'.` |
| `lat` / `lon` out of range | `Vector N: lat must be between -90 and 90.` / `... lon must be between -180 and 180.` |
| `azimuth_deg` not in `[0, 360)` | `Vector N: azimuth_deg must be at least 0 and less than 360.` |
| `range_km` given but not finite and > 0 | `Vector N: range_km, if given, must be finite and > 0.` |
| custom `family` not `linear` / `quadratic` | `Vector N: custom.family must be one of ['linear', 'quadratic'].` |
| `local_gradient` not finite | `Vector N: custom.local_gradient must be finite.` |
| linear custom with `rate_of_increase` / `second_gradient` | `Vector N: a linear custom tilt takes neither rate_of_increase nor second_gradient.` |
| quadratic custom without / with both forms | `Vector N: a quadratic custom tilt requires rate_of_increase or second_gradient.` / `... takes either rate_of_increase or second_gradient, not both.` |
| bad `second_gradient` | `Vector N: second_gradient.distance_km must be finite and > 0.` / `... gradient_m_per_km must be finite.` |

**Relaxed fields.** For `direction.type != "azimuth"`, `tilt_azimuth` is not
needed. The messages say which condition applied:

| condition | `detail` |
|---|---|
| `tilt_azimuth` missing, azimuth direction | `tilt_azimuth is required for a single-azimuth model.` |
| `tilt_azimuth` / `tilt_factor` missing, no `tilt_model` | `tilt_azimuth is required for a basic run.` / `tilt_factor (gradient at the spillway) is required for a basic run.` |
| `tilt_factor` missing, azimuth direction | `tilt_factor (gradient at the spillway) is required for a single-azimuth model.` |
| `tilt_factor` missing, some vector has `custom: null` | `tilt_factor (global gradient at the spillway) is required because vector N uses the global profile.` |
| `profile` missing, some vector has `custom: null` | `tilt_model.profile is required because vector N uses the global profile.` |

When **every** vector is custom the global `profile` is unused: it may be
omitted, and if sent it is ignored (`run_parameters.json` records `"profile":
null`). The `hinge` still applies (its mode point, and the zero-gradient guard).

**Hinge in gradient form** (custom tilts present): `origin` sets the gradient to
zero wherever `phi < 0`, `distance` wherever `phi < -distance_km`, `none` applies
no mode clamp; in every mode the guard also zeroes any negative gradient behind
the spillway, so uplift never re-increases there. `hinge_source` is `"guard"`
when the guard set a clamp (then `hinge_km` is the extent it reached,
approximately -- the field has no single zero-gradient point), else `"mode"` /
`null`.

**Least-squares caveat.** Two custom gradients at one azimuth are not a
curl-free field, so the least-squares surface trades some of the gradient for a
slight tilt of the `U = 0` contour (a few metres in a typical basin) and a small
non-zero drift behind the spillway. The map draws the spillway's own isobase from
`phi = 0`.

**Response additions.** `/api/process` in vectors mode adds a header

```
X-Tilt-Model-Diagnostics: {"misfit_rms_deg": 1.2, "misfit_max_deg": 2.9, "worst_vector": 1}
```

(`worst_vector` is a 0-based index into the submitted vectors; the fields are
`null` when no vector lies inside the working grid), and `run_parameters.json`
gains `diagnostics` (below). Model warnings -- vectors disagreeing strongly
(near-opposite directions over > 1% of the area), a worst misfit above 15
degrees, a vector far outside the DEM (more than half the DEM's diagonal beyond
its bounds; it still counts) -- arrive in `X-Processing-Warnings` like any other.

**Consistency with the preview.** `/api/uplift-preview` builds its grid from the
preflight `bounds_wgs84`; a run builds it from the real working raster. They are
identical when the raster is EPSG:4326 and negligibly different when it was
reprojected (the preflight bounds are the reprojected WGS84 bounds). If they ever
diverge, trust the run.

## Shore-point surface (`direction.type == "points"`)

For shorelines with elevation data: fit the deformed water plane directly
instead of describing it with directions and profiles. The user supplies shore
points (a location and the present elevation of a shoreline feature there); the
tool fits a **polynomial trend surface** of order 1, 2 or 3 -- a smooth trend,
not an exact interpolating spline, because real shoreline elevations scatter and
an exact fit would chase that noise. **Magnitude comes from the data**: no
profile family, no `tilt_factor`.

```json
"direction": {
  "type": "points",
  "points": [ { "lat": 49.12, "lon": -96.85, "elevation_m": 331.4, "label": "optional site name" }, "..." ],
  "order": 2,
  "hinge": "none",              // "none" (default) | "origin"
  "extrapolation": "warn"       // "warn" (default) | "mask"
}
```

The top-level `profile` and `hinge` objects must be **absent**, and neither
`tilt_azimuth` nor `tilt_factor` is required.

**The math.** In the run's local frame (`backend/main.py::_local_en_km`, with the
`diagonal_km` of the full raster -- so the fit's frame and the run's are
identical), point *j* is at `(e_j, n_j)` km with elevation `z_j`. Fit, by
`numpy.linalg.lstsq`,
`S(e, n) = sum_{a+b<=p} beta_ab (e/L)^a (n/L)^b`, `L` the largest absolute frame
coordinate among the points (3, 6 or 10 terms; the constant term is included --
`S` is an absolute elevation). The uplift is `U = S(e, n) - S(origin)`, so
`U(origin) = 0` and the DEM-authoritative target elevation still holds; the
tilted DEM is `DEM - U`. `S` is evaluated analytically per pixel (exact and
cheap), so windowed and in-memory runs agree. **The isobases the preview shows
are contours of `S`** (absolute meters a.s.l.); the model itself uses `U`.

**Hinge** (`direction.hinge`): `none` applies `U` as fitted on both sides of the
spillway (the data define it there); `origin` clamps `U = max(U, 0)`, so nothing
changes where the surface lies below its value at the spillway.

**Extrapolation** (`direction.extrapolation`): polynomial surfaces diverge
quickly outside their data. The convex hull of the points is buffered by 10% of
its diameter (`HULL_BUFFER_FRACTION`, a first-pass value) and rasterized onto the
DEM (a 1024-cell grid, so a masked edge is not visibly stair-stepped).
`warn` computes everywhere and warns when more than 20% of the DEM is outside;
`mask` sets the tilted DEM to NaN outside the hull (no contours there; a warning
gives the percentage, and a `422` says so if the whole DEM would be masked). The
contour step trims valid/NaN edges in every run
(`extract_strandline_contours(..., trim_nan_edges=True)`, the default): without it the
contour that follows a valid/NaN boundary would be drawn along the hull edge (and
along real nodata borders). Also warned:
the origin outside the hull (the surface is extrapolated to it) and a
near-collinear or clustered set (condition number above 1e8).

**Fit statistics**, per order the point count allows: n, terms, R^2, adjusted
R^2, RMSE (m), per-point residuals (`z_j - S_j`), standardized residuals
(`residual / sqrt(SSE / dof)`) and the indexes with `|standardized| > 3` -- shown
as possible outliers, never removed. (With few degrees of freedom this can never
exceed 3, so flagging mostly matters for larger sets.) The **minimum point count**
is `terms + 3`: 6, 9 and 13 for orders 1, 2 and 3.

**Validation** (all `422`):

| rule | `detail` |
|---|---|
| `profile` or `hinge` present | `profile and hinge don't apply to shore-point surfaces — magnitude comes from the data.` |
| `points` missing | `tilt_model.direction.points is required when direction.type is 'points'.` |
| not 1-5000 points | `tilt_model.direction.points must contain 1 to 5000 points.` |
| bad lat / lon / elevation | `Shore point N: lat must be between -90 and 90.` / `... lon must be between -180 and 180.` / `... elevation_m must be a finite number.` |
| bad `label` | `Shore point N: label must be a string.` / `... label must be at most 100 characters.` |
| `order` not 1, 2 or 3 (a float or bool is not) | `tilt_model.direction.order must be one of [1, 2, 3].` |
| too few points for the order | `An order-K surface needs at least M shore points (got N); add points or choose a lower order.` |
| unknown `hinge` / `extrapolation` | `tilt_model.direction.hinge must be one of ['none', 'origin'].` / `... extrapolation must be one of ['warn', 'mask'].` |
| `points`/`order`/`hinge`/`extrapolation` on another type | `tilt_model.direction.<key> is only allowed when direction.type is 'points'.` |
| all points at one location | `The shore points must not all be at the same location.` |
| `mask` would remove every cell | `The DEM lies entirely outside the shore points' buffered hull; masking would remove every cell. ...` |

Duplicate coordinates are allowed (real data has them). Like a `vectors` model, a
`points` model is *validated* before the upload is written and *built* once the
working raster exists.

**Diagnostics.** `X-Tilt-Model-Diagnostics` carries
`{ "order", "r2", "rmse_m", "dem_fraction_outside_hull" }`; `run_parameters.json`
carries the full fit statistics and coefficients (see below), and the points go
in `shore_points.csv`.

## `POST /api/profile-preview`

The uplift-vs-distance curve a run would apply, for the Advanced form's chart.
JSON body, no raster I/O, so it is cheap enough to call on every (debounced)
edit. Validation and model-building are the same as `/api/process`'s (same
messages).

```json
{
  "tilt_azimuth": 28, "tilt_factor": 0.35,
  "tilt_model": { "...": "same schema as above" },
  "origin": [-110.5, 45.25],
  "bounds_wgs84": [-111.0, 44.8, -110.0, 45.7],
  "samples": 121
}
```

`origin` (`[lon, lat]`), `bounds_wgs84` (`[west, south, east, north]`, as
returned by `/api/preflight`) and `samples` (2-2000, default 121) are optional.

```json
{
  "d_km":              [...],          // evenly spaced over the DEM's d-range
  "uplift_m":          [...],          // U(d) with the clamp applied
  "gradient_m_per_km": [...],          // g(d), zero where clamped
  "d_range_km":        [-70.1, 88.4],  // the four bbox corners projected onto the azimuth
  "hinge_km":          -53.9,          // where uplift stops changing (0 for `origin`); null when unclamped
  "hinge_source":      "guard",        // "mode" | "guard" | null
  "warnings":          ["..."]         // warnings a run would emit (the guard is not one)
}
```

The d-range converts the four `bounds_wgs84` corners with the same local frame
the run uses (`backend/main.py::_local_en_km`) and projects them onto the
azimuth. If `origin` or `bounds_wgs84` is missing it falls back to
`[-100, 100]` km and adds a warning saying the range is nominal. `422` for a
bad model, `samples` out of range, malformed `origin` / `bounds_wgs84`, or a
profile that evaluates to non-finite values over the range.

## `POST /api/uplift-preview`

The isobases and fit quality a `vectors` run would produce (the spatial
generalisation of `/api/profile-preview`, which stays for the `azimuth`
direction; each 422s and points at the other for the wrong `direction.type`).
JSON body, no raster I/O.

```json
{
  "tilt_azimuth": null, "tilt_factor": 0.35,
  "tilt_model": { "...": "direction.type 'vectors'" },
  "origin": [-110.5, 45.25],
  "bounds_wgs84": [-111.0, 44.8, -110.0, 45.7]
}
```

`origin` and `bounds_wgs84` are both required. The grid is built from the bounds
with a synthetic 512x512 transform (only the bounds matter), through the same
code a run uses. Same validation and messages as `/api/process`.

```json
{
  "isobases": { "type": "FeatureCollection", "features": [ ... ] },  // LineStrings, property `uplift_m`
  "interval_m": 10,                   // the smallest 1/2/5 x 10^n giving <= 12 nonzero levels
  "vectors": [ { "index": 0, "misfit_deg": 2.1 }, ... ],   // null misfit: vector outside the working grid
  "misfit_rms_deg": 2.4, "misfit_max_deg": 3.0, "worst_vector": 1,
  "degenerate_fraction": 0.0,
  "hinge_km": 0.0, "hinge_source": "mode",
  "warnings": ["..."]
}
```

Isobases are contours of the uplift grid at those levels, mapped back to
lon/lat through `_local_en_to_lonlat`; the spillway's own (`uplift_m: 0`) is
contoured from `phi`. A build takes about 0.3 s at a typical vector count (about
0.8 s at the 200-vector maximum), so no reduced preview grid was needed.

## `POST /api/fit-uplift-surface`

The shore-point counterpart of `/api/uplift-preview`: statistics for every order
the point count allows, residuals, the surface's isobases and the data hull, for
the map and the tilt section. JSON body, no raster I/O.

```json
{
  "points": [ { "lat": 49.12, "lon": -96.85, "elevation_m": 331.4, "label": "optional" }, "..." ],
  "order": 2,
  "origin": [-96.9, 49.0],
  "bounds_wgs84": [-98.0, 48.5, -96.0, 49.5],
  "hinge": "none",              // optional, default "none"
  "extrapolation": "warn"       // optional, default "warn"
}
```

Validated exactly like a `points` direction (same messages), so a `order` the
point count cannot support is a `422`. `origin` and `bounds_wgs84` are both
required (the fit's frame depends on the DEM's extent). The grid is built from
the bounds with a synthetic 512x512 transform, through the same code a run uses.

```json
{
  "orders": [ { "order": 1, "n": 40, "terms": 3, "r2": 0.91, "adj_r2": 0.90, "rmse_m": 4.5 }, "..." ],
  "selected": { "order": 2, "n": 40, "terms": 6, "r2": 0.98, "adj_r2": 0.97, "rmse_m": 1.9,
                "cond": 12.3, "residuals_m": [ ... ], "std_residuals": [ ... ], "outlier_indices": [ 7 ] },
  "isobases": { "inside": { "type": "FeatureCollection", "features": [ ... ] },
                "outside": { "type": "FeatureCollection", "features": [ ... ] } },   // LineStrings, property `elevation_m`
  "interval_m": 10,
  "hull": { "type": "Polygon", "coordinates": [ ... ] },   // the buffered hull, lon/lat
  "dem_fraction_outside_hull": 0.18,
  "origin_inside_hull": true,
  "warnings": [ "..." ]
}
```

`orders` covers only the orders the point count allows; `selected` is the
requested one, and its `residuals_m` are aligned with the submitted points by
index. Isobases are contours of `S` (absolute meters a.s.l.) at the smallest
1/2/5 x 10^n giving at most 12 levels over the range `S` takes inside the hull,
split by the buffered hull: `inside` (solid on the map) and `outside` (dashed;
always empty in `mask` mode). `cond` is `null` when the design matrix is singular
(JSON has no Infinity). The other two preview endpoints `422` and point here for
`points` models.

## `run_parameters.json`

Every `/api/process` zip carries this file, in every mode (a basic run has
`"tilt_model": null`), so a result can be reproduced or audited later. The
frontend does not read it.

```json
{
  "schema_version": 1,
  "app_commit": "60ac2e9c...",           // git commit of the running app; null if git is unavailable
  "generated_at": "2026-09-25T07:18:03+00:00",  // UTC
  "input_file": "dem.tif",               // file name only, never a server path
  "origin": { "lon": -104.9, "lat": 44.9 },
  "effective_target_elevation": 500.0,   // what the run actually contoured
  "target_elevation_source": "dem",      // "dem" | "manual"
  "submitted_target_elevation": 450.0,
  "tilt_azimuth": 90.0,                  // null when omitted (vectors mode)
  "tilt_factor": 20.0,                   // null when omitted (every vector custom)
  "tilt_model": {                        // the parsed, validated model, or null. A second-gradient
    "...": "..."                         // quadratic carries both `second_gradient` (as supplied) and
  },                                     // the derived `rate_of_increase`
  "hinge_km": -40.0,                     // where uplift stops changing, and what set it
  "hinge_source": "guard",               // "mode" | "guard" | null (both null for a basic run)
  "diagnostics": null,                   // vectors mode: { case, misfit_deg[], misfit_rms_deg,
                                         // misfit_max_deg, worst_vector, degenerate_fraction, ranges_km[], grid };
                                         // points mode: { type: "points", fit: { order, n, terms, r2, adj_r2, rmse_m, cond,
                                         // residuals_m[], std_residuals[], outlier_indices[], L_km, coefficients:
                                         // [{ east_power, north_power, scaled, per_km }] }, orders[], dem_fraction_outside_hull,
                                         // origin_inside_hull }. `per_km` are the coefficients of S in frame km.
  "include_dem": false,
  "selection_radius_km": null,
  "reprojected": { "was_reprojected": false, "from_crs": null }
}
```

## Selection radius

When `selection_radius_km` is present, only strandline contours that come
within that distance of the origin (geodesic, WGS84) are written to the
output GeoPackage, so the `contour.geojson` in the zip -- read back from the
filtered `.gpkg` -- matches the download. Empty or absent means no
filtering, identical to a run without the field.

- **Keep-whole ("intersects") semantics:** a contour is kept, entire and
  unclipped, if any part of it comes within the radius; contours entirely
  outside are dropped. (`backend/main.py::select_contours_within_radius`
  also supports a `"clip"` mode that trims contours at the circle's edge, but
  it's not exposed as a request field.)
- The origin may lie outside the DEM (within the usual 500 m threshold); the
  radius works the same way. The tilted DEM raster is not cropped.
- Must be finite and `> 0`, otherwise `422`.
- If nothing survives the filter, the request still succeeds: the
  GeoPackage's contour layer is empty and `X-Processing-Warnings` says so
  (with the pre-filter total).

## Origin modes

The old single `origin_x` / `origin_y` / `origin_crs` fields were ambiguous
about coordinate order and units. They're replaced by three explicit modes,
each with one unambiguous `origin_value` format:

- **`match_raster`** -- `origin_value` is `"x,y"`, plain floats, in the
  raster's own native CRS and axis order exactly as read from the file. No
  CRS knowledge is required from the client; the server reads the raster's
  CRS itself.
- **`decimal_degrees`** -- `origin_value` is hemisphere-annotated and
  order-agnostic, e.g. `"45.25N,110.55W"` or `"110.55W,45.25N"` -- either
  order is accepted, since the `N`/`S`/`E`/`W` letter (not position)
  determines which token is latitude and which is longitude.
- **`epsg`** -- `origin_value` is `"x,y"`, plain floats, in the units native
  to whatever CRS `origin_epsg` specifies (e.g. `"EPSG:32612"`). Unit
  ambiguity for a projected CRS (meters vs. feet, for example) is resolved
  by the EPSG code choice itself -- a given UTM zone in meters and the same
  zone in feet are different EPSG codes -- so there's no separate unit field.

Any `origin_mode` outside these three values, or a malformed `origin_value`
for the given mode, returns `422`.

## Plausibility check

Once an origin is resolved to (lon, lat) in EPSG:4326 -- regardless of which
of the three modes produced it -- it's checked against the raster's own
extent using true geodesic (curved-earth) distance: the nearest point on the
raster's WGS84 bounding box to the origin is found (zero distance if the
origin already falls inside the box), and if that distance exceeds **500
meters**, the request is rejected with `422`.

This is an unconditional check applied the same way underneath all three
origin modes -- it is not a per-mode setting, and there is no way to disable
or configure it per request. It exists to catch the "right coordinates,
wrong file" and "right file, transposed/mistyped coordinates" class of
mistakes before the (expensive) raster reprojection and processing pipeline
runs.

## Target elevation resolution

`calculate_tilt`'s projected distance -- and therefore the elevation delta
-- is exactly zero at the tilt origin, since the tilt is a plane pivoting
through that point. That means the tilted DEM's value at the origin is
always identical to the raw DEM's value there, regardless of `tilt_azimuth`
or `tilt_factor`. A submitted `target_elevation` that disagrees with the
DEM's actual elevation at the origin produces a strandline contour that
doesn't pass through the origin at all -- undermining the point of anchoring
the tilt there.

To prevent that, when the origin falls inside the DEM on valid (non-nodata)
data, **the DEM's own elevation there is authoritative and silently-but-
visibly overrides the submitted `target_elevation`** -- "silently" in that
processing doesn't block or error, "visibly" in that the response says so
via the `X-Target-Elevation-Source` / `X-Target-Elevation-Note` headers (see
below). Manual `target_elevation` is only actually used when the origin
falls outside the DEM's bounds, or lands on a nodata cell -- the two cases
where there's nothing to sample.

**Spillway-elevation assumption.** The strandline is contoured at the spillway's
**present** DEM elevation. This assumes the spillway sill has not been
significantly eroded, incised, or buried since the shoreline formed, and it
ignores the depth of water flowing over the sill (typically a few meters). Where
either is significant, enter the target elevation manually by placing the origin
off the DEM, or accept that offset. (The Origin section shows a one-line note to
this effect under the target-elevation field.)

This is enforced server-side in `/api/process` itself, against the same
reprojected working raster the pipeline actually tilts.
`/api/origin-elevation` is a preview-only convenience for showing this
ahead of a full run -- not a second source of truth, and not something
`/api/process` trusts or depends on.

## Errors

| status | cause |
|---|---|
| `422` | neither or both of `dem_file`/`file_path` provided; a required `tilt_azimuth` / `tilt_factor` missing (see "Relaxed fields"); `selection_radius_km` not finite or not `> 0`; an invalid `tilt_model` (see "Tilt model"); unsupported file extension; invalid `origin_mode`; missing `origin_epsg` for `epsg` mode; malformed `origin_value`; unrecognized `origin_epsg`; origin more than 500m from the raster's extent; `target_elevation` outside the DEM's elevation range |
| `413` | upload exceeds the configured size limit |
| `400` | corrupted/unreadable GeoTIFF; `file_path` does not point to an existing file; other file-not-found conditions |
| `500` | unexpected processing failure |

A `/api/process` response also carries these headers when applicable:

- `X-Source-CRS-Reprojected-From` -- the input raster's original CRS, if it
  wasn't already EPSG:4326.
- `X-Processing-Warnings` -- backend `UserWarning`s, e.g. origin outside the
  raster's extent post-tilt.
- `X-Tilt-Model-Diagnostics` -- vectors mode only: compact JSON of the direction
  field's fit (`misfit_rms_deg`, `misfit_max_deg`, `worst_vector`). See "Vector
  direction field".
- `X-Target-Elevation-Source` -- always present; `"dem"` if the DEM's own
  elevation at the origin was used, `"manual"` if the submitted
  `target_elevation` was used instead. See "Target elevation resolution"
  above.
- `X-Target-Elevation-Note` -- present only when the source is `"dem"` and
  the submitted `target_elevation` differed from the DEM-sampled value by
  more than a small tolerance; a human-readable explanation of the override.
- `X-Selection-Summary` -- present only when `selection_radius_km` was
  supplied: `"N strandline contour(s) kept within R km of the origin."`. `N`
  counts only what was kept; the pre-filter total appears only in the
  empty-result warning.
