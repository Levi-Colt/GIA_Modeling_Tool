import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import usBoundary from '../assets/us_boundary.json'

// Basemap tile sources (raster, EPSG:3857). Owned here, not in MapPanel, so
// the external tile hosts live in one place.
//
// These URLs are ABSOLUTE ON PURPOSE. CLAUDE.md's "no leading slash / relative
// routing" rule covers only the app's own paths (api/...) under
// jupyter-server-proxy; external tile hosts are fetched by the user's browser,
// not the pod. Do not "fix" them into relative URLs.
//
// NRCan endpoints verified live 2026-09-25: the newer host
// (maps-cartes.services.geo.ca) responds on .../MapServer/tile/{z}/{y}/{x};
// the older host (geoappext.nrcan.gc.ca) did not respond. CBMT_TXT_3857 is the
// English text overlay (CBCT_* names are the French variants).
// maxNativeZoom, read off the live services: USGS Topo tiles exist through
// level 16; NRCan's geometry cache 404s above level 15, and its text overlay
// returns blank tiles above 15, so both are capped at 15.
const NRCAN_HOST = 'https://maps-cartes.services.geo.ca/server2_serveur2/rest/services/BaseMaps'

export const BASEMAPS = {
  usgs_topo: {
    label: 'USGS Topo',
    layers: [
      {
        url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
        maxNativeZoom: 16
      }
    ],
    attribution: 'USGS The National Map'
  },
  nrcan_cbmt: {
    label: 'Canada Base Map (NRCan)',
    // Geometry layer first, English text overlay on top; rendered together as
    // one layer group so the layer control treats them as a single basemap.
    layers: [
      { url: `${NRCAN_HOST}/CBMT_CBCT_GEOM_3857/MapServer/tile/{z}/{y}/{x}`, maxNativeZoom: 15 },
      { url: `${NRCAN_HOST}/CBMT_TXT_3857/MapServer/tile/{z}/{y}/{x}`, maxNativeZoom: 15 }
    ],
    attribution:
      '© His Majesty the King in Right of Canada, Natural Resources Canada (Open Government Licence – Canada)'
  }
}

export const DEFAULT_BASEMAP_KEY = 'usgs_topo'

// Picks a basemap for a DEM extent ([west, south, east, north], WGS84): NRCan
// when the extent's center falls outside the US boundary, USGS Topo otherwise.
// A coarse boundary is fine -- this only decides which basemap looks better,
// and the user can override it.
export function pickBasemapKey(extent) {
  if (!Array.isArray(extent) || extent.length !== 4 || !extent.every(Number.isFinite)) {
    return DEFAULT_BASEMAP_KEY
  }
  const [west, south, east, north] = extent
  const center = [(west + east) / 2, (south + north) / 2]
  return booleanPointInPolygon(center, usBoundary) ? 'usgs_topo' : 'nrcan_cbmt'
}
