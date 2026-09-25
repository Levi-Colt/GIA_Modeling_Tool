import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import GeoRasterLayer from 'georaster-layer-for-leaflet'
import bbox from '@turf/bbox'
import CompassRose from './CompassRose.jsx'
import { BASEMAPS, DEFAULT_BASEMAP_KEY, pickBasemapKey } from '../../utils/basemap.js'

// DEM preview opacity: low enough that the basemap reads through it.
const RASTER_OPACITY = 0.6

// This component is intentionally "dumb": it never calls into geoprocessing
// logic and doesn't know what produced its data. It accepts a single shape
// and renders whatever fields are present. See "Map component contract" in
// documentation/GIA_Tool_Penpot_Spec.md / documentation/VISUALIZATION_PIPELINE_SPEC.md.
//
// mapData: {
//   extent?: [west, south, east, north],       // WGS84, from /api/preflight
//   rasterPreview?: { georaster },              // from /api/raster-preview
//   origin?: [lon, lat],                        // from /api/resolve-point
//   azimuthLine?: [[lon, lat], [lon, lat]],      // computed client-side (utils/geometry.js)
//   contour?: GeoJSON,                           // from /api/process's bundled response
//   tiltedRasterPreview?: { georaster }          // from /api/process's bundled response
//   selectionRadius?: { center: [lon, lat], radiusKm } // derived in App.jsx deriveMapDataFromForm
// }
//
// azimuthDeg is a separate prop (not a mapData field): the compass rose is
// fixed UI chrome that rotates with the raw tilt-azimuth degree value,
// independent of whether origin/extent have resolved enough to compute an
// azimuthLine geometry yet.
//
// Layer order (bottom to top): basemap (its own 'basemap' pane, below
// tilePane, so ordering against the raster doesn't depend on insertion
// order) -> rasterPreview -> tiltedRasterPreview (when present, replaces the
// input raster as the visible base rather than stacking) -> selectionRadius
// circle -> contour -> azimuthLine -> origin marker -> compass rose (chrome,
// drawn as a DOM overlay, not a map layer).
//
// The basemap is chosen automatically from mapData.extent (utils/basemap.js)
// until the user picks one in the layer control; after that their choice wins
// for the rest of the session.
export default function MapPanel({ mapData, azimuthDeg }) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const layersRef = useRef({})
  const basemapsRef = useRef({}) // key -> L.layerGroup
  const activeBasemapRef = useRef(DEFAULT_BASEMAP_KEY)
  const manualBasemapRef = useRef(false)
  const autoSwitchingRef = useRef(false)

  // Init the Leaflet map once. No react-leaflet dependency is installed
  // (only `leaflet` itself, per the spec's Libraries section), so this is
  // vanilla, imperative Leaflet wired through refs/effects rather than
  // declarative components.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = L.map(containerRef.current)
    map.attributionControl.setPrefix(false)
    map.setView([20, 0], 2)
    mapRef.current = map

    // Basemaps live in their own pane below tilePane (200), so they always
    // sit under GeoRasterLayer (an L.GridLayer, i.e. tilePane) no matter
    // which was added first.
    map.createPane('basemap')
    map.getPane('basemap').style.zIndex = 150
    const baseLayers = {}
    const groups = {}
    for (const [key, basemap] of Object.entries(BASEMAPS)) {
      const group = L.layerGroup(
        basemap.layers.map(({ url, maxNativeZoom }) =>
          L.tileLayer(url, {
            pane: 'basemap',
            maxNativeZoom,
            maxZoom: 19,
            attribution: basemap.attribution
          })
        )
      )
      groups[key] = group
      baseLayers[basemap.label] = group
    }
    basemapsRef.current = groups
    activeBasemapRef.current = DEFAULT_BASEMAP_KEY
    groups[DEFAULT_BASEMAP_KEY].addTo(map)

    L.control.layers(baseLayers, null, { position: 'topleft', collapsed: true }).addTo(map)
    L.control.scale({ position: 'bottomleft', metric: true, imperial: false, maxWidth: 150 }).addTo(map)

    // Leaflet also fires baselayerchange when we switch layers in code (the
    // control listens to layer add events), so ignore those: only a user
    // pick in the control counts as a manual override.
    map.on('baselayerchange', (e) => {
      const key = Object.keys(groups).find((k) => groups[k] === e.layer)
      if (key) activeBasemapRef.current = key
      if (!autoSwitchingRef.current) manualBasemapRef.current = true
    })

    // The container's size is driven by the page layout (full-height column,
    // stacked/side-by-side breakpoint), not by Leaflet, so tell Leaflet when it
    // changes -- otherwise it renders gray tiles after resizes. Debounced to
    // one call per animation frame.
    let frame = null
    let observer = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        if (frame !== null) return
        frame = requestAnimationFrame(() => {
          frame = null
          map.invalidateSize()
        })
      })
      observer.observe(containerRef.current)
    }

    return () => {
      observer?.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
      map.remove()
      mapRef.current = null
    }
  }, [])

  // Auto-pick the basemap once per new DEM extent, unless the user has
  // already chosen one by hand. Keyed on the extent's values so unrelated
  // mapData updates (origin, azimuth, results) don't re-trigger it.
  const extentKey = mapData?.extent ? mapData.extent.join(',') : null
  useEffect(() => {
    const map = mapRef.current
    if (!map || !extentKey || manualBasemapRef.current) return
    const key = pickBasemapKey(extentKey.split(',').map(Number))
    if (key === activeBasemapRef.current) return
    autoSwitchingRef.current = true
    try {
      map.removeLayer(basemapsRef.current[activeBasemapRef.current])
      basemapsRef.current[key].addTo(map)
    } finally {
      autoSwitchingRef.current = false
    }
    activeBasemapRef.current = key
  }, [extentKey])

  // React to mapData changes: add/remove/replace layers. Doesn't branch on
  // "input mode" vs "result mode" -- just renders whatever fields are
  // present, per the map component contract.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const layers = layersRef.current

    const baseGeoraster =
      mapData?.tiltedRasterPreview?.georaster || mapData?.rasterPreview?.georaster
    if (layers.base) {
      map.removeLayer(layers.base)
      layers.base = null
    }
    if (baseGeoraster) {
      layers.base = new GeoRasterLayer({ georaster: baseGeoraster, opacity: RASTER_OPACITY, resolution: 128 })
      layers.base.addTo(map)
    }

    if (layers.radius) {
      map.removeLayer(layers.radius)
      layers.radius = null
    }
    if (mapData?.selectionRadius) {
      const { center: [lon, lat], radiusKm } = mapData.selectionRadius
      // Visual guide only -- L.circle's meters-with-latitude-correction is
      // close enough to the geodesic circle the backend actually uses.
      // Deliberately not part of the fit-bounds chain below.
      layers.radius = L.circle([lat, lon], {
        radius: radiusKm * 1000,
        color: '#7c3aed',
        weight: 1.5,
        dashArray: '4 4',
        fill: false,
        interactive: false
      }).addTo(map)
    }

    if (layers.contour) {
      map.removeLayer(layers.contour)
      layers.contour = null
    }
    if (mapData?.contour) {
      layers.contour = L.geoJSON(mapData.contour, {
        style: { color: '#dc2626', weight: 2 }
      }).addTo(map)
    }

    if (layers.azimuth) {
      map.removeLayer(layers.azimuth)
      layers.azimuth = null
    }
    if (mapData?.azimuthLine) {
      const latlngs = mapData.azimuthLine.map(([lon, lat]) => [lat, lon])
      layers.azimuth = L.polyline(latlngs, {
        color: '#2563eb',
        weight: 2,
        dashArray: '6 4'
      }).addTo(map)
    }

    if (layers.origin) {
      map.removeLayer(layers.origin)
      layers.origin = null
    }
    if (mapData?.origin) {
      const [lon, lat] = mapData.origin
      layers.origin = L.circleMarker([lat, lon], {
        radius: 6,
        color: '#111827',
        weight: 2,
        fillColor: '#f59e0b',
        fillOpacity: 1
      }).addTo(map)
    }

    // Fit the view to whatever's most specific: the contour (result state)
    // takes priority over the raster base, which takes priority over the
    // raw preflight extent (input state, before a raster preview has
    // loaded). Contour's bbox is computed with @turf/bbox directly on the
    // GeoJSON, kept independent of the Leaflet layer that renders it.
    let bounds = null
    if (mapData?.contour) {
      const [west, south, east, north] = bbox(mapData.contour)
      bounds = L.latLngBounds([south, west], [north, east])
    } else if (layers.base?.getBounds) {
      bounds = layers.base.getBounds()
    } else if (mapData?.extent) {
      const [west, south, east, north] = mapData.extent
      bounds = L.latLngBounds([south, west], [north, east])
    }
    if (bounds && bounds.isValid()) {
      map.fitBounds(bounds, { maxZoom: 16, padding: [12, 12] })
    }
  }, [mapData])

  const hasAnyData = mapData && Object.values(mapData).some(Boolean)

  return (
    // Fills whatever cell AppLayout gives it (full height beside the form on
    // wide screens, h-[55vh] when stacked); the ResizeObserver above keeps
    // Leaflet in sync with that size.
    <div className="relative h-full w-full overflow-hidden bg-gray-50">
      <div ref={containerRef} className="h-full w-full" />
      <CompassRose azimuthDeg={azimuthDeg} />
      {!hasAnyData && (
        <div className="pointer-events-none absolute inset-0 z-[500] flex items-center justify-center bg-white/80 p-5 text-center">
          <p className="max-w-[220px] text-xs text-gray-400">
            Will show your DEM extent, origin point, and tilt direction as you fill in the form.
          </p>
        </div>
      )}
    </div>
  )
}
