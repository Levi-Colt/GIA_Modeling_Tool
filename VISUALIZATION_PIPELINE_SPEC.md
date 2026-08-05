# GIA Modeling Tool — Visualization Pipeline Spec

Companion to `GIA_Tool_Penpot_Spec.md` and `api/README.md`. Covers the map
panel's real implementation — currently a placeholder (see `CLAUDE.md`,
"Open items"). Ties every piece back to what the backend can cheaply
produce, same discipline as the other spec docs.

## Goal

Three things need to show up in the map panel:

1. As soon as a DEM is uploaded/pathed — the (reprojected) raster itself.
2. As soon as origin + azimuth are filled in — the origin point and tilt
   direction, drawn over the raster.
3. After `/api/process` succeeds — the strandline contour, and optionally
   the tilted DEM raster.

None of this touches `main.py`/`app.py`'s core geoprocessing. It's all
either client-side geometry math or small additions to the `api/` layer.

## Libraries

- **Leaflet** — already the right call, already installed. No reason to
  reach for MapLibre GL here; nothing in this app needs GPU vector-tile
  rendering at scale.
- **`georaster` + `georaster-layer-for-leaflet`** — already installed,
  unused so far. Use these for both raster previews (input and result).
  Chosen over a flat PNG quicklook specifically so hover-to-read-elevation
  keeps working — real value for a research tool, not just decoration.
- **Turf.js** (`@turf/destination`, `@turf/bbox`) — new dependency. Handles
  the geodesic point/line math for the azimuth line so nobody hand-rolls
  bearing math. Import individual packages, not the full `@turf/turf`
  bundle, to keep bundle size down.
- **`fflate`** — new dependency, ~8kB. Client-side unzip for `/api/process`'s
  new bundled response (see below).
- **`@ngageoint/geopackage`** — considered and rejected for this version.
  Would let the client read the contour vector layer straight out of the
  downloaded `.gpkg`, but the `modified_dem` raster table is written via
  GDAL's GPKG *gridded-coverage* extension, which this library's raster
  support (built around image tile pyramids) is not confirmed to handle.
  Rather than build around an untested assumption, the backend sends
  raster previews as separate small GeoTIFFs instead (below) — this also
  means the client never needs to parse the `.gpkg` at all, and the
  existing download-the-`.gpkg` UX in `ResultsSuccess.jsx` is untouched.

## Map component contract (extends the existing one)

Current shape, from `MapPanel.jsx`:

```
{ extent, origin, azimuthLine, contour?, tiltedRasterUrl? }
```

Revised:

```js
{
  extent,              // [west, south, east, north] WGS84 — from /api/preflight
  rasterPreview,       // { georaster } — parsed from /api/raster-preview's GeoTIFF bytes
  origin,              // [lon, lat] — from /api/resolve-point
  azimuthLine,         // [[lon, lat], [lon, lat]] — computed client-side with Turf
  contour,             // GeoJSON FeatureCollection — from /api/process's bundled response
  tiltedRasterPreview  // { georaster } — parsed from /api/process's bundled preview.tif
}
```

`MapPanel` stays a dumb renderer: it takes whatever fields are present and
draws them, same principle as before, just a wider shape. It still doesn't
care whether `contour` came from a live run or `tiltedRasterPreview` is
absent because `include_dem` was off.

Layer order (bottom to top): `rasterPreview` → `tiltedRasterPreview` (when
present, replaces the input raster as the visible base rather than
stacking) → `contour` → `azimuthLine` → `origin` marker → compass rose
(fixed UI chrome, not a map layer, always rendered regardless of data).

## Stage 1 — Input preview (extent, origin, azimuth line)

Fully client-side once two backend pieces exist. No new heavy compute.

**Extend `POST /api/preflight`** — add `bounds_wgs84` to the response,
using `get_raster_bounds_wgs84()` (already in `api/crs.py`, already used in
`/api/process`). One extra cheap call, no reprojection of pixel data.

```json
{
  "crs": "EPSG:32612",
  "bounds_wgs84": [-110.62, 45.18, -110.48, 45.31],
  "band_count": 1,
  "use_windowed_io": false,
  "needs_casting": false,
  "peak_ram_mb": 812.4
}
```

**New `POST /api/resolve-point`** — cheap coordinate resolution, no file
I/O. Wraps the existing `parse_xy_pair` / `parse_decimal_degrees_hemisphere`
/ `normalize_origin_to_wgs84` functions in `api/crs.py`. Deliberately
*not* built on `/api/origin-elevation`, which reprojects the entire raster
just to sample one point — fine as an occasional explicit check, too
expensive to fire on every coordinate-field blur for a live map preview.

Request (JSON body):
```json
{
  "origin_mode": "match_raster",
  "origin_value": "512300,5023100",
  "origin_epsg": null,
  "native_crs": "EPSG:32612"
}
```
`native_crs` is required only for `match_raster` mode, and comes from the
`crs` field already cached client-side from `/api/preflight` — no raster
re-read needed. For `decimal_degrees` and `epsg` modes this is a pure
string-parse + `pyproj` point transform.

Response:
```json
{ "lon": -110.55, "lat": 45.25 }
```
`422` on parse failure, same taxonomy as the other origin-handling
endpoints.

**Azimuth line (client-side, no backend call):**
```js
import destination from '@turf/destination'

function azimuthLine(origin, azimuthDeg, extent) {
  const diagonalKm = haversineKm([extent[0], extent[1]], [extent[2], extent[3]])
  const end = destination(origin, diagonalKm, azimuthDeg, { units: 'kilometers' })
  // then clip the origin->end segment to `extent` before handing to MapPanel
  return [origin, clippedEndCoords]
}
```
Recompute on every `tiltAzimuth`/origin change — cheap, no debouncing
needed.

**Compass rose:** fixed SVG/CSS element positioned in a map corner,
rotates with `tiltAzimuth`. Renders regardless of whether origin/extent
are resolved yet — it's chrome, not a data layer. Build this first; it's
useful even before the rest of stage 1 lands.

## Stage 2 — Uploaded raster preview

**New `POST /api/raster-preview`** — same dual file-resolution as
`/api/preflight` (`dem_file` / `file_path`). Does a *decimated* read
(`rasterio` `out_shape`, cheap regardless of source file size — this is
what makes it safe to call on every drop/path-blur, unlike a full read),
reprojects that small array to EPSG:4326, and returns it as a small
in-memory GeoTIFF:

```python
# sketch, not final implementation
with rasterio.open(input_path) as src:
    scale = min(1, PREVIEW_MAX_DIM / max(src.width, src.height))
    out_shape = (int(src.height * scale), int(src.width * scale))
    decimated = src.read(1, out_shape=out_shape)
# reproject `decimated` to EPSG:4326, write to a rasterio.io.MemoryFile,
# return its bytes with Content-Type: image/tiff
```

`PREVIEW_MAX_DIM` — suggest 1024px on the long side as a starting point;
revisit if browser memory becomes an issue at that size.

Fires once, after `/api/preflight` succeeds (not on every keystroke).
Frontend parses the response with `georaster`'s `parseGeoraster()` and
hands the result to `MapPanel` as `rasterPreview.georaster`.

## Stage 3 — Result preview (contour + tilted raster)

**Change `/api/process`'s response** from a bare `FileResponse` to a zip
bundle:

```
strandlines.gpkg    — unchanged, exactly what's downloaded today
preview_tilted.tif  — decimated, WGS84, same recipe as Stage 2's preview,
                       built from the tilted array process_dem already
                       holds in memory (or the windowed tilted_path file)
                       right before it writes the .gpkg — no second run
                       of the pipeline, no re-reading the .gpkg after
contour.geojson      — the same GeoDataFrame app.py already builds for
                       the strandline_contour layer, dumped to GeoJSON
                       before/alongside the .gpkg write
```

`preview_tilted.tif` is present only when `include_dem` was `true` —
mirrors the existing behavior where the raster layer itself is optional.

Response headers (`X-Source-CRS-Reprojected-From`, `X-Processing-Warnings`,
`X-Target-Elevation-Source`, `X-Target-Elevation-Note`) stay exactly as
they are today; only the body changes shape, from raw `.gpkg` bytes to a
zip containing it.

**Frontend (`client.js` / `runProcess`):** unzip with `fflate`, keep the
`.gpkg` blob for the existing download flow untouched, parse
`preview_tilted.tif` with `georaster` (skip if absent), parse
`contour.geojson` directly (it's already GeoJSON, no parsing library
needed) — hand both to `MapPanel` via `tiltedRasterPreview` / `contour`.

**Test impact:** `tests/test_write_dem_to_gpkg.py` and friends test the
geoprocessing layer directly (`main.py`/`app.py`), unaffected. The API
layer's own tests (currently checking `/api/process` returns a `.gpkg`
directly) need updating to unzip first — flag this explicitly when
implementing, since it's the one place this spec changes previously-tested
behavior rather than adding new surface area.

## Fallback plan, if the raster previews turn out to be a real problem

If `PREVIEW_MAX_DIM` decimation isn't fast/cheap enough in practice on
CryoCloud (e.g. very large windowed-pipeline files), or georeferenced
raster overlays prove fussier than expected in Leaflet at this stage, the
fallback is a non-georeferenced flat image instead: render the same
decimated array as a plain colorized PNG (elevation colormap, no CRS
metadata) and show it as a static `<img>` alongside the map rather than
draped on it — a "what does the topography look like" view, not a "where
is it" view. This drops `georaster`/`georaster-layer-for-leaflet` for that
specific panel but keeps everything else in this spec (extent, origin,
azimuth line, contour) unchanged, since those don't depend on the raster
rendering approach at all. Worth a quick spike against a real CryoCloud
pod (per `CLAUDE.md`'s "next milestone") before committing either way.

## Explicitly out of scope for this version

- Multiple origins/azimuths with per-extent tilt regions (future
  multi-region GIA simulation mode). The `azimuthLine` field stays
  singular this round — generalizing to `azimuthLines: []` later is a
  non-breaking additive change to this same contract, not a redesign.
- Any raster styling/colormap picker UI — pick one reasonable elevation
  colormap for `georaster-layer-for-leaflet` to start, revisit later.
- Auth/rate-limiting on the two new endpoints — matches the rest of the
  API's current stance (see `CLAUDE.md`, "Open items").

## Implementation order

1. Compass rose (no dependencies on anything else, immediate visual payoff).
2. `/api/preflight` + `bounds_wgs84`, `/api/resolve-point`, client-side
   azimuth line — completes the input-preview half.
3. `/api/raster-preview` + `georaster` wiring — uploaded raster on the map.
4. `/api/process` zip bundling + frontend unzip — result preview
   (contour + optional tilted raster).
