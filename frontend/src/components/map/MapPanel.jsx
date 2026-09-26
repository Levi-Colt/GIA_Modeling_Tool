import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import GeoRasterLayer from 'georaster-layer-for-leaflet'
import bbox from '@turf/bbox'
import CompassRose from './CompassRose.jsx'
import { createVectorLayer } from './VectorLayer.js'
import { BASEMAPS, DEFAULT_BASEMAP_KEY, pickBasemapKey } from '../../utils/basemap.js'
import { isobaseLabel } from '../../utils/vectors.js'

// DEM preview opacity: low enough that the basemap reads through it.
const RASTER_OPACITY = 0.6

// Overlay stacking, bottom to top, per the map contract: raster (tilePane, 200)
// -> selection radius -> isobases -> contour -> vectors -> azimuth line ->
// origin. Each gets its own pane so the order never depends on which layer was
// (re)added last -- editing the vectors must not rebuild the raster.
const OVERLAY_PANES = { radius: 401, isobases: 402, contour: 403, vectors: 404, azimuth: 405, origin: 406 }

// This component is intentionally "dumb": it never calls into geoprocessing
// logic and doesn't know what produced its data. It accepts a single shape
// and renders whatever fields are present. See "Map component contract" in
// documentation/GIA_Tool_Penpot_Spec.md / documentation/VISUALIZATION_PIPELINE_SPEC.md.
//
// mapData: {
//   extent?: [west, south, east, north],       // WGS84, from /api/preflight
//   rasterPreview?: { georaster },              // from /api/raster-preview
//   origin?: [lon, lat],                        // from /api/resolve-point
//   azimuthLine?: [[lon, lat], [lon, lat]],      // computed client-side (utils/geometry.js); azimuth mode only
//   contour?: GeoJSON,                           // from /api/process's bundled response
//   tiltedRasterPreview?: { georaster }          // from /api/process's bundled response
//   selectionRadius?: { center: [lon, lat], radiusKm } // derived in App.jsx deriveMapDataFromForm
//   vectors?: [{ id, number, lon, lat, azimuthDeg | null, rangeKm | null,
//                lengthKm, selected, custom }]   // spec 5; drawn as arrows
//   isobases?: GeoJSON                           // from /api/uplift-preview; LineStrings with `uplift_m`
// }
//
// Optional `editing` prop (vectors mode, form view only -- absent on the results
// view, where the arrows are display-only):
//   editing?: {
//     mode: 'none' | 'addVector',
//     onAddVector({ lon, lat, azimuthDeg, rangeKm }),   // azimuthDeg/rangeKm null for a click
//     onUpdateVector(id, { lon?, lat?, azimuthDeg?, rangeKm? }),
//     onSelectVector(id),
//     onExitAddMode()
//   }
// MapPanel still does no geoprocessing: it renders what it is given and reports
// geometry edits through these callbacks, once, on drag end. Bearing/distance
// math is utils/geometry.js's; the gestures live in VectorLayer.js.
//
// azimuthDeg is a separate prop (not a mapData field): the compass rose is
// fixed UI chrome that rotates with the raw tilt-azimuth degree value,
// independent of whether origin/extent have resolved enough to compute an
// azimuthLine geometry yet.
//
// Layer order (bottom to top): basemap (its own 'basemap' pane, below
// tilePane) -> rasterPreview -> tiltedRasterPreview (when present, replaces the
// input raster as the visible base rather than stacking) -> selectionRadius
// circle -> isobases (with uplift labels) -> contour -> vectors -> azimuthLine
// (azimuth mode only) -> origin marker -> compass rose (chrome, drawn as a DOM
// overlay, not a map layer).
//
// The basemap is chosen automatically from mapData.extent (utils/basemap.js)
// until the user picks one in the layer control; after that their choice wins
// for the rest of the session.
//
// Each layer group has its own effect keyed on that field's identity, so the
// caller should keep unchanged fields referentially stable (App.jsx memoizes).
export default function MapPanel({ mapData, azimuthDeg, editing }) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const layersRef = useRef({})
  const vectorLayerRef = useRef(null)
  const basemapsRef = useRef({}) // key -> L.layerGroup
  const activeBasemapRef = useRef(DEFAULT_BASEMAP_KEY)
  const manualBasemapRef = useRef(false)
  const autoSwitchingRef = useRef(false)
  const fittedRef = useRef({ contour: null, base: null, extentKey: null })

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
    for (const [name, z] of Object.entries(OVERLAY_PANES)) {
      map.createPane(name)
      map.getPane(name).style.zIndex = z
    }
    vectorLayerRef.current = createVectorLayer(map, { pane: 'vectors', container: containerRef.current })
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
      vectorLayerRef.current?.destroy()
      vectorLayerRef.current = null
      layersRef.current = {} // every layer belonged to the map being removed
      fittedRef.current = { contour: null, base: null, extentKey: null }
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

  // Layers: one effect per group, keyed on that field's identity, so a change to
  // one (say, dragging a vector) never rebuilds the others. No "input mode" vs
  // "result mode" branching -- each just renders whatever field is present, per
  // the map component contract.
  const baseGeoraster = mapData?.tiltedRasterPreview?.georaster || mapData?.rasterPreview?.georaster
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const layers = layersRef.current
    if (layers.base) {
      map.removeLayer(layers.base)
      layers.base = null
    }
    if (baseGeoraster) {
      layers.base = new GeoRasterLayer({ georaster: baseGeoraster, opacity: RASTER_OPACITY, resolution: 128 })
      layers.base.addTo(map)
    }
  }, [baseGeoraster])

  const selectionRadius = mapData?.selectionRadius
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const layers = layersRef.current
    if (layers.radius) {
      map.removeLayer(layers.radius)
      layers.radius = null
    }
    if (selectionRadius) {
      const { center: [lon, lat], radiusKm } = selectionRadius
      // Visual guide only -- L.circle's meters-with-latitude-correction is
      // close enough to the geodesic circle the backend actually uses.
      // Deliberately not part of the fit-bounds chain below.
      layers.radius = L.circle([lat, lon], {
        pane: 'radius',
        radius: radiusKm * 1000,
        color: '#7c3aed',
        weight: 1.5,
        dashArray: '4 4',
        fill: false,
        interactive: false
      }).addTo(map)
    }
  }, [selectionRadius])

  // Isobases: thin blue lines from /api/uplift-preview, each labelled at one end
  // with its relative uplift ("+40 m"); the spillway's own (0) is heavier.
  const isobases = mapData?.isobases
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const layers = layersRef.current
    if (layers.isobases) {
      map.removeLayer(layers.isobases)
      layers.isobases = null
    }
    if (isobases?.features?.length) {
      const group = L.layerGroup()
      L.geoJSON(isobases, {
        pane: 'isobases',
        interactive: false,
        style: (f) => ({ color: '#3b82f6', weight: f.properties?.uplift_m === 0 ? 2.5 : 1, opacity: 0.85 })
      }).addTo(group)
      for (const f of isobases.features) {
        const coords = f.geometry?.coordinates
        if (!coords?.length) continue
        const [lon, lat] = coords[coords.length - 1]
        L.marker([lat, lon], {
          pane: 'isobases',
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: '',
            iconSize: null,
            html:
              '<span style="font:600 11px system-ui,sans-serif;color:#1d4ed8;white-space:nowrap;' +
              'text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff;">' +
              `${isobaseLabel(f.properties?.uplift_m)}</span>`
          })
        }).addTo(group)
      }
      layers.isobases = group.addTo(map)
    }
  }, [isobases])

  const contour = mapData?.contour
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const layers = layersRef.current
    if (layers.contour) {
      map.removeLayer(layers.contour)
      layers.contour = null
    }
    if (contour) {
      layers.contour = L.geoJSON(contour, { pane: 'contour', style: { color: '#dc2626', weight: 2 } }).addTo(map)
    }
  }, [contour])

  // Vectors: rebuilt when the list (or the arrows' selection) changes, or when
  // editing switches on/off or into add mode. The callbacks are refreshed every
  // render without a rebuild, so an unrelated re-render can never drop a drag.
  const vectors = mapData?.vectors
  const editingMode = editing ? editing.mode : 'off'
  useEffect(() => {
    vectorLayerRef.current?.render(vectors, editing)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vectors, editingMode])
  useEffect(() => {
    vectorLayerRef.current?.setEditing(editing)
  })

  const azimuthLine = mapData?.azimuthLine
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const layers = layersRef.current
    if (layers.azimuth) {
      map.removeLayer(layers.azimuth)
      layers.azimuth = null
    }
    if (azimuthLine) {
      const latlngs = azimuthLine.map(([lon, lat]) => [lat, lon])
      layers.azimuth = L.polyline(latlngs, {
        pane: 'azimuth',
        color: '#2563eb',
        weight: 2,
        dashArray: '6 4'
      }).addTo(map)
    }
  }, [azimuthLine])

  const origin = mapData?.origin
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const layers = layersRef.current
    if (layers.origin) {
      map.removeLayer(layers.origin)
      layers.origin = null
    }
    if (origin) {
      const [lon, lat] = origin
      layers.origin = L.circleMarker([lat, lon], {
        pane: 'origin',
        radius: 6,
        color: '#111827',
        weight: 2,
        fillColor: '#f59e0b',
        fillOpacity: 1
      }).addTo(map)
    }
  }, [origin])

  // Fit the view to whatever's most specific: the contour (result state) takes
  // priority over the raster base, which takes priority over the raw preflight
  // extent (input state, before a raster preview has loaded). Contour's bbox is
  // computed with @turf/bbox directly on the GeoJSON, kept independent of the
  // Leaflet layer that renders it. Refits only when one of those three changes
  // -- not on every edit, so a user's pan/zoom survives editing vectors.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const fitted = fittedRef.current
    if (fitted.contour === contour && fitted.base === baseGeoraster && fitted.extentKey === extentKey) return
    fittedRef.current = { contour, base: baseGeoraster, extentKey }

    let bounds = null
    if (contour) {
      const [west, south, east, north] = bbox(contour)
      bounds = L.latLngBounds([south, west], [north, east])
    } else if (layersRef.current.base?.getBounds) {
      bounds = layersRef.current.base.getBounds()
    } else if (extentKey) {
      const [west, south, east, north] = extentKey.split(',').map(Number)
      bounds = L.latLngBounds([south, west], [north, east])
    }
    if (bounds && bounds.isValid()) {
      map.fitBounds(bounds, { maxZoom: 16, padding: [12, 12] })
    }
  }, [contour, baseGeoraster, extentKey])

  const hasAnyData = mapData && Object.values(mapData).some(Boolean)

  return (
    // Fills whatever cell AppLayout gives it (full height beside the form on
    // wide screens, h-[55vh] when stacked); the ResizeObserver above keeps
    // Leaflet in sync with that size.
    <div className="relative h-full w-full overflow-hidden bg-gray-50">
      <div ref={containerRef} className="h-full w-full" />
      <CompassRose azimuthDeg={azimuthDeg} />
      {editing?.mode === 'addVector' && (
        <div className="absolute left-1/2 top-3 z-[1000] flex -translate-x-1/2 items-center gap-2 rounded-md bg-white/95 px-3 py-1.5 text-xs shadow">
          <span className="text-gray-600">Drag to place a vector; click to place one without a direction.</span>
          <button
            type="button"
            onClick={() => editing.onExitAddMode?.()}
            className="rounded-md bg-gray-900 px-2 py-1 text-white"
          >
            Done
          </button>
        </div>
      )}
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
