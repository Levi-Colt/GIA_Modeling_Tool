// This component is intentionally "dumb": it never calls into geoprocessing
// logic and doesn't know what produced its data. It accepts a single shape
// and renders whatever fields are present. See "Map component contract" in
// GIA_Tool_Penpot_Spec.md.
//
// mapData: {
//   extent?: [minX, minY, maxX, maxY],   // from the uploaded raster
//   origin?: [lon, lat],                 // parsed from origin_value
//   azimuthLine?: [[lon, lat], [lon, lat]], // origin -> azimuth direction
//   contour?: GeoJSON,                   // populated after /process succeeds
//   tiltedRasterUrl?: string             // populated after /process succeeds
// }
//
// Not wired to Leaflet yet — that's the next real implementation step,
// using `leaflet` + `georaster-layer-for-leaflet` for the in-memory raster
// overlay (no tile server needed, matches the "temporary local preview"
// requirement directly).
export default function MapPanel({ mapData }) {
  const hasAnyData = mapData && Object.values(mapData).some(Boolean)

  return (
    <div className="sticky top-4 flex min-h-[340px] flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 p-5 text-center">
      <p className="mb-1 text-sm font-medium text-gray-500">Map view — coming soon</p>
      <p className="max-w-[220px] text-xs text-gray-400">
        {hasAnyData
          ? 'Received data to render — Leaflet integration not wired up yet.'
          : 'Will show your DEM extent, origin point, and tilt direction as you fill in the form.'}
      </p>
    </div>
  )
}
