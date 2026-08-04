# API layer

`POST /api/process` wraps `app.process_dem` as an HTTP endpoint: upload a DEM
GeoTIFF, describe the tilt origin and parameters, get back a `.gpkg` with the
strandline contour (and optionally the tilted DEM).

Routes are namespaced under `/api` (`/api/process`, `/api/preflight`,
`/api/origin-elevation`, `/api/health`) so the frontend's relative `api/...`
fetches (required for `jupyter-server-proxy` compatibility, see `CLAUDE.md`)
resolve correctly with no path rewriting needed in either the Vite dev proxy
or production.

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
  "band_count": 1,
  "use_windowed_io": false,
  "needs_casting": false,
  "peak_ram_mb": 812.4
}
```

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

This is enforced server-side in `/api/process` itself, against the same
reprojected working raster the pipeline actually tilts.
`/api/origin-elevation` is a preview-only convenience for showing this
ahead of a full run -- not a second source of truth, and not something
`/api/process` trusts or depends on.

## Errors

| status | cause |
|---|---|
| `422` | neither or both of `dem_file`/`file_path` provided; unsupported file extension; invalid `origin_mode`; missing `origin_epsg` for `epsg` mode; malformed `origin_value`; unrecognized `origin_epsg`; origin more than 500m from the raster's extent; `target_elevation` outside the DEM's elevation range |
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
