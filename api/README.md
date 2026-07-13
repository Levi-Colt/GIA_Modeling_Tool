# API layer

`POST /process` wraps `app.process_dem` as an HTTP endpoint: upload a DEM
GeoTIFF, describe the tilt origin and parameters, get back a `.gpkg` with the
strandline contour (and optionally the tilted DEM).

Run locally from the repository root:
```bash
uvicorn api.main:app --reload
```
Interactive docs (request/response schema, try-it-out) are served at `/docs`.

## Request fields

| field | type | required | notes |
|---|---|---|---|
| `dem_file` | file | yes | GeoTIFF, `.tif`/`.tiff` |
| `origin_mode` | string | yes | one of `"match_raster"`, `"decimal_degrees"`, `"epsg"` |
| `origin_value` | string | yes | format depends on `origin_mode` -- see below |
| `origin_epsg` | string | only if `origin_mode == "epsg"` | e.g. `"EPSG:32612"` |
| `tilt_azimuth` | float | yes | tilt direction, degrees |
| `tilt_factor` | float | yes | meters of elevation change per km |
| `target_elevation` | float | yes | paleo-elevation to contour, meters |
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

## Errors

| status | cause |
|---|---|
| `422` | unsupported file extension; invalid `origin_mode`; missing `origin_epsg` for `epsg` mode; malformed `origin_value`; unrecognized `origin_epsg`; origin more than 500m from the raster's extent; `target_elevation` outside the DEM's elevation range |
| `413` | upload exceeds the configured size limit |
| `400` | corrupted/unreadable GeoTIFF, or other file-not-found conditions |
| `500` | unexpected processing failure |

A response also carries `X-Source-CRS-Reprojected-From` (if the input raster
wasn't already EPSG:4326) and `X-Processing-Warnings` (backend `UserWarning`s,
e.g. origin outside the raster's extent post-tilt) headers when applicable.
