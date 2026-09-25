# GIA Modeling Tool — Map Quality-of-Life Spec

Spec 1 of the Sep 2026 feature set. Frontend-only: no changes to `api/` or
`backend/`. Builds on `documentation/VISUALIZATION_PIPELINE_SPEC.md` (read
it first for the `MapPanel` contract) and keeps every rule in `CLAUDE.md`,
in particular: `MapPanel` stays a dumb renderer, and app routing stays
relative.

## Goal

1. Give the map a real basemap so users can see at a glance that their DEM,
   origin, and contours are georeferenced correctly.
2. Add a scale bar that updates on zoom.
3. Make the Run button visibly disabled until the form is ready, and say
   what's missing.

## Out of scope

- **Layout / map proportion (map ≥ 2/3 of the screen).** Deliberately deferred
  to the upcoming input-interface spec (Basic/Advanced toggle). Shrinking the
  form column to 1/3 only makes sense alongside the redesigned inputs. Do not
  change the `grid-cols-[1.3fr_1fr]` layout or the map height in this spec.
- Any change to `/api/*` routes or the backend.

---

## A1. Basemap layers

Two raster tile basemaps, both free, no API key, both in Web Mercator
(EPSG:3857, Leaflet's default).

| Key | Label | Tiles | Attribution |
|---|---|---|---|
| `usgs_topo` | USGS Topo | `https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}` | `USGS The National Map` |
| `nrcan_cbmt` | Canada Base Map (NRCan) | Geometry layer + text overlay, see below | `© His Majesty the King in Right of Canada, Natural Resources Canada (Open Government Licence – Canada)` |

**NRCan Canada Base Map – Transportation (CBMT).** Published as two cached
ArcGIS MapServer services in EPSG:3857: a geometry-only layer
(`CBMT_CBCT_GEOM_3857`) and an English text-only overlay (`CBMT_TXT_3857`).
Render them together as one `L.layerGroup` so the layer control treats them
as a single basemap. NRCan has been moving these services between hosts, so
**verify the live endpoints before hard-coding them**:

- Newer host: `https://maps-cartes.services.geo.ca/server2_serveur2/rest/services/BaseMaps/`
- Older host: `https://geoappext.nrcan.gc.ca/arcgis/rest/services/BaseMaps/`

For each service, confirm three things: it responds on the
`.../MapServer/tile/{z}/{y}/{x}` path; which host is live; and that the text
service you pick is the English one. `CBCT_*` names are the French variants;
the English text service is `CBMT_TXT_3857`. Put the final URLs in one
constants module (`frontend/src/utils/basemap.js`, below) with a comment
recording the date checked.

Notes:
- The CBMT has full coverage within Canada and only partial data elsewhere.
  It is transportation-focused with no shaded relief. That's acceptable: its
  job here is geographic orientation outside USGS Topo's detailed coverage.
- Set `maxNativeZoom` per layer from each service's cache levels (read them off
  the MapServer's JSON page) so Leaflet upscales instead of requesting
  nonexistent tiles. USGS Topo is cached to level 16. Keep the map's existing
  `maxZoom: 16` fit cap.
- **These URLs are absolute on purpose.** `CLAUDE.md`'s "no leading slash"
  rule applies only to the app's own paths (`api/...`) under
  `jupyter-server-proxy`. External tile hosts are fetched by the user's
  browser, not the pod. Do not "fix" them into relative URLs.

### Pane ordering

`GeoRasterLayer` extends `L.GridLayer`, so it lands in the same `tilePane` as
basemap tiles, and ordering between them would depend on insertion order.
Avoid that: create a dedicated pane once at map init and put the basemaps
in it.

```js
map.createPane('basemap')
map.getPane('basemap').style.zIndex = 150   // below tilePane (200)
L.tileLayer(url, { pane: 'basemap', ... })
```

Resulting draw order (bottom to top): basemap → raster preview / tilted
raster → contour → azimuth line → origin marker → compass rose (DOM chrome).

### Raster overlay opacity

The DEM preview currently renders at `opacity: 0.85`, which largely hides
whatever is under it. Lower it to **0.6** so the basemap reads through, which
is the whole point of adding one. This is a single constant in `MapPanel.jsx`.
No slider in this spec.

## A2. Choosing the basemap automatically

Default to USGS Topo. When a DEM extent arrives (`mapData.extent`, from
`/api/preflight`), pick a basemap once for that extent:

- Compute the extent's center.
- If the center falls **outside** the United States → switch to `nrcan_cbmt`.
- Otherwise → `usgs_topo`.

Implement this as a **pure function** in a new `frontend/src/utils/basemap.js`:

```js
export const BASEMAPS = { usgs_topo: {...}, nrcan_cbmt: {...} }   // URLs, labels, attribution, zoom caps
export function pickBasemapKey(extent) { ... }                    // -> 'usgs_topo' | 'nrcan_cbmt'
```

The US test uses a bundled, simplified US boundary (conterminous US plus
Alaska and Hawaii) and `@turf/boolean-point-in-polygon`:

- **Boundary data:** Natural Earth admin-0 at 1:110m or 1:50m scale. It's
  public domain and only a few KB once the US feature is extracted. Commit it
  as `frontend/src/assets/us_boundary.json`.
- **Dependency:** `@turf/boolean-point-in-polygon` is new. Import the
  individual package, not `@turf/turf`, matching the existing `@turf/bbox` /
  `@turf/destination` convention.

A coarse boundary is fine; this only decides which basemap looks better. DEMs
that straddle the border (Great Lakes) resolve by center point, and the user
can override.

### Layer control and manual override

- Add `L.control.layers(baseLayers, null, { position: 'topleft', collapsed: true })`
  under the zoom control. The compass rose occupies the top-right, so keep
  them apart.
- **Manual choice wins.** Once the user picks a basemap in the control (listen
  for `baselayerchange`), stop auto-switching for the rest of the session.
  Track this with a ref, not persisted state.
- Auto-selection only runs when `extent` actually changes (a new DEM), not on
  every `mapData` update.

## A3. Scale bar

```js
L.control.scale({ position: 'bottomleft', metric: true, imperial: false, maxWidth: 150 }).addTo(map)
```

Added once at map init. Leaflet updates it on zoom/pan by itself. It measures
at the map's vertical center, which is correct behavior for Web Mercator.

## A4. Attribution

`MapPanel.jsx` currently sets `attributionControl: false`. Both basemap
licences require attribution, so turn it back on. Use
`map.attributionControl.setPrefix(false)` if the default Leaflet prefix makes
the small panel too crowded. The `attribution` strings live on each tile layer
(from `BASEMAPS`), so the control shows whichever basemap is active.

## A5. Run button: disabled state and missing-field reasons

### `frontend/src/utils/readiness.js`

Refactor into a function that returns reasons, and keep the old boolean as a
thin wrapper so existing callers and `CoordinateSteps.test.jsx` keep working
untouched:

```js
export function getReadiness(formState) {
  const missing = []
  // same checks as today, in the same order, each pushing a short
  // user-facing string instead of returning false, e.g.:
  //   'a valid DEM', 'origin coordinates', 'origin EPSG code',
  //   'tilt azimuth', 'tilt factor', 'target elevation',
  //   'origin elevation check (click out of the coordinate field)'
  // 'checking' status → 'origin elevation check in progress'
  return { ready: missing.length === 0, missing }
}

export function isReadyToRun(formState) {
  return getReadiness(formState).ready
}
```

Preserve the exact current semantics, including the
`elevationCheckStatus === 'idle' | 'checking'` gating and its explanatory
comment. Wording is up to you, but keep each reason short and user-facing.

### `App.jsx`

```jsx
const { ready, missing } = getReadiness(formState)
<button
  onClick={handleRunModel}
  disabled={!ready}
  className="mt-4 w-full rounded-md bg-gray-900 py-2 font-medium text-white
             disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500"
>
  Run model
</button>
{!ready && (
  <p className="mt-1 text-xs text-gray-500">Still needed: {missing.join(', ')}</p>
)}
```

Keep the `if (!isReadyToRun(formState)) return` guard in `handleRunModel`. A
disabled attribute is not a substitute for the guard, just as the frontend
check is not a substitute for the backend's 422s.

---

## Files touched

- `frontend/src/components/map/MapPanel.jsx`: basemap pane and layers, layer
  control, auto-selection effect, scale bar, attribution, raster opacity.
- `frontend/src/utils/basemap.js` (new): `BASEMAPS`, `pickBasemapKey`.
- `frontend/src/assets/us_boundary.json` (new).
- `frontend/src/utils/readiness.js`: `getReadiness` plus a wrapper.
- `frontend/src/App.jsx`: disabled button and reasons line.
- `frontend/package.json`: `@turf/boolean-point-in-polygon`.
- `CLAUDE.md`: in the map-panel design-decision entry, note the basemap pane,
  that `utils/basemap.js` owns the external tile URLs (absolute by design),
  and the auto-pick-with-manual-override rule.
- `documentation/frontend-README.md`: mark basemap, scale, and disabled Run as
  implemented.

## Tests

Vitest (`npm test`):

- **`utils/basemap.test.js`:** `pickBasemapKey` returns `usgs_topo` for a
  Colorado extent, `nrcan_cbmt` for a Manitoba extent (Lake Agassiz region,
  e.g. `[-100, 50, -97, 53]`) and a Quebec extent, `usgs_topo` for an Alaska
  extent, and a defined, non-crashing result for `null`.
- **`utils/readiness.test.js`:** an empty form lists all expected reasons;
  a complete form gives `{ ready: true, missing: [] }`; each individual gap
  (EPSG mode without an EPSG code, `elevationCheckStatus` idle or checking)
  produces its own reason; `isReadyToRun` agrees with `getReadiness().ready`
  in every case.
- The existing `CoordinateSteps.test.jsx` passes unchanged.

Python: `pytest -c setup/pytest.ini --rootdir=.` stays green with no new
failures. The known numpy-version failure noted in `CLAUDE.md` is pre-existing.

`npm run build` is clean.

### Manual check (dev loop)

1. Load a US DEM: USGS Topo shows, the DEM overlays in the right place, and
   names and boundaries are visible.
2. Load a Canadian DEM (Manitoba or Quebec): the basemap switches to NRCan
   and English labels show.
3. Pick a basemap manually, then load another DEM: the manual choice sticks.
4. Zoom in and out: the scale bar updates, and attribution for the active
   basemap is visible.
5. With an empty form, the Run button is grey and not clickable, with the
   reasons listed. Fill fields one at a time and watch the list shrink until
   the button enables.
