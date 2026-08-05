import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import GeoRasterLayer from 'georaster-layer-for-leaflet'
import bbox from '@turf/bbox'
import CompassRose from './CompassRose.jsx'

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
// }
//
// azimuthDeg is a separate prop (not a mapData field): the compass rose is
// fixed UI chrome that rotates with the raw tilt-azimuth degree value,
// independent of whether origin/extent have resolved enough to compute an
// azimuthLine geometry yet.
//
// Layer order (bottom to top): rasterPreview -> tiltedRasterPreview (when
// present, replaces the input raster as the visible base rather than
// stacking) -> contour -> azimuthLine -> origin marker -> compass rose
// (chrome, drawn as a DOM overlay, not a map layer).
export default function MapPanel({ mapData, azimuthDeg }) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const layersRef = useRef({})

  // Init the Leaflet map once. No react-leaflet dependency is installed
  // (only `leaflet` itself, per the spec's Libraries section), so this is
  // vanilla, imperative Leaflet wired through refs/effects rather than
  // declarative components.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = L.map(containerRef.current, { attributionControl: false })
    map.setView([20, 0], 2)
    mapRef.current = map

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

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
      layers.base = new GeoRasterLayer({ georaster: baseGeoraster, opacity: 0.85, resolution: 128 })
      layers.base.addTo(map)
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
    <div className="sticky top-4 relative min-h-[340px] overflow-hidden rounded-xl border border-gray-200 bg-gray-50">
      <div ref={containerRef} className="h-[340px] w-full" />
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
