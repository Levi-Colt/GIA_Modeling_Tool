# API layer

`POST /api/process` wraps `app.process_dem` as an HTTP endpoint: upload a DEM
GeoTIFF, describe the tilt origin and parameters, get back a zip bundle
containing the strandline contour `.gpkg` (and optionally the tilted DEM),
plus the small preview artifacts the frontend's map panel renders (see
"Response bundle" below).

Routes are namespaced under `/api` (`/api/process`, `/api/preflight`,
`/api/resolve-point`, `/api/raster-preview`, `/api/origin-elevation`,
`/api/profile-preview`, `/api/health`) so the frontend's relative `api/...` fetches (required for
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
| `tilt_azimuth` | float | yes | tilt direction, degrees |
| `tilt_factor` | float | yes | meters of elevation change per km |
| `target_elevation` | float | yes | paleo-elevation to contour, meters -- may be overridden server-side, see "Target elevation resolution" below |
| `include_dem` | bool | no (default `true`) | also embed the tilted DEM as a raster layer |
| `selection_radius_km` | float | no | keep only strandline contours that come within this many km of the resolved origin -- see "Selection radius" below |
| `tilt_model` | string (JSON) | no | uplift model: profile family + hinge rule -- see "Tilt model" below. Absent means the basic linear tilt (byte-identical to a run before this field existed). `tilt_azimuth` / `tilt_factor` stay required; `tilt_factor` is always the model's gradient at the origin (c1) |

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
| `direction.type` not `"azimuth"` | `tilt_model.direction.type must be one of ['azimuth'].` |
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

The model is parsed and built before the upload is written to disk, so a bad
model fails fast.

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
  "tilt_azimuth": 90.0,
  "tilt_factor": 20.0,
  "tilt_model": {                        // the parsed, validated model, or null. A second-gradient
    "...": "..."                         // quadratic carries both `second_gradient` (as supplied) and
  },                                     // the derived `rate_of_increase`
  "hinge_km": -40.0,                     // where uplift stops changing, and what set it
  "hinge_source": "guard",               // "mode" | "guard" | null (both null for a basic run)
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
| `422` | neither or both of `dem_file`/`file_path` provided; `selection_radius_km` not finite or not `> 0`; an invalid `tilt_model` (see "Tilt model"); unsupported file extension; invalid `origin_mode`; missing `origin_epsg` for `epsg` mode; malformed `origin_value`; unrecognized `origin_epsg`; origin more than 500m from the raster's extent; `target_elevation` outside the DEM's elevation range |
| `413` | upload exceeds the configured size limit |
| `400` | corrupted/unreadable GeoTIFF; `file_path` does not point to an existing file; other file-not-found conditions |
| `500` | unexpected processing failure |

A `/api/process` response also carries these headers when applicable:

- `X-Source-CRS-Reprojected-From` -- the input raster's original CRS, if it
  wasn't already EPSG:4326.
- `X-Processing-Warnings` -- backend `UserWarning`s, e.g. origin outside the
  raster's extent post-tilt.
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
