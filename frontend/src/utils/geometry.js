import destination from '@turf/destination'
import bearing from '@turf/bearing'
import distance from '@turf/distance'

const EARTH_RADIUS_KM = 6371

// A pointer drag shorter than this many screen pixels counts as a click when
// adding a vector on the map.
export const CLICK_DRAG_PX = 8

// Vectors default to an arrow this fraction of the DEM's diagonal long when
// they carry no range.
export const DEFAULT_ARROW_FRACTION = 0.1
// ...and this long (km) when there is no DEM extent yet either.
export const FALLBACK_ARROW_KM = 10

// Great-circle distance in km. Only used to size the azimuth line's length
// (the raster's own diagonal), not for anything precision-sensitive -- not
// worth pulling in a turf module for this one formula.
export function haversineKm([lon1, lat1], [lon2, lat2]) {
  const toRad = (deg) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a))
}

// Initial bearing from `from` to `to` ([lon, lat] each), in degrees clockwise
// from north, normalized to [0, 360).
export function bearingDeg(from, to) {
  return ((bearing(from, to) % 360) + 360) % 360
}

// Distance between two [lon, lat] points in km (turf's great-circle).
export function distanceKm(from, to) {
  return distance(from, to, { units: 'kilometers' })
}

// The point `km` from `from` along `azimuthDeg`, as [lon, lat].
export function pointAlong(from, km, azimuthDeg) {
  return destination(from, km, azimuthDeg, { units: 'kilometers' }).geometry.coordinates
}

// Geometry for one vector's arrow, all as [lon, lat]: a shaft from `base` to
// the tip `lengthKm` along `azimuthDeg`, and a small triangular head at the tip
// (apex, then the two barbs, which sit back along the shaft and 25 degrees to
// either side).
export function arrowGeometry(base, azimuthDeg, lengthKm) {
  const tip = pointAlong(base, lengthKm, azimuthDeg)
  const headKm = lengthKm * 0.18
  const barb = (offset) => pointAlong(tip, headKm, azimuthDeg + 180 + offset)
  return { shaft: [base, tip], head: [tip, barb(-25), barb(25)] }
}

// The arrow length (km) for a vector: its range when it has one, else
// DEFAULT_ARROW_FRACTION of the DEM's diagonal, else FALLBACK_ARROW_KM.
export function arrowLengthKm(rangeKm, extent) {
  if (Number.isFinite(rangeKm) && rangeKm > 0) return rangeKm
  if (!extent) return FALLBACK_ARROW_KM
  return DEFAULT_ARROW_FRACTION * haversineKm([extent[0], extent[1]], [extent[2], extent[3]])
}

// True when a pointer went from `start` to `end` (screen px, {x, y}) by less
// than CLICK_DRAG_PX -- a click, not a drag.
export function isClick(start, end, thresholdPx = CLICK_DRAG_PX) {
  return Math.hypot(end.x - start.x, end.y - start.y) < thresholdPx
}

// Clips the segment origin->end to the axis-aligned bbox [west, south, east,
// north] using Liang-Barsky. Visual-only clipping for the map preview (not
// geodesic-precise) -- lon/lat treated as a flat plane, which is fine at the
// scale of a single DEM extent. Returns null if the segment doesn't
// intersect the box at all.
function clipLineToBbox([x1, y1], [x2, y2], [west, south, east, north]) {
  const dx = x2 - x1
  const dy = y2 - y1
  let tMin = 0
  let tMax = 1

  const edges = [
    [-dx, x1 - west],
    [dx, east - x1],
    [-dy, y1 - south],
    [dy, north - y1]
  ]

  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null // parallel to this edge and outside it
      continue
    }
    const t = q / p
    if (p < 0) {
      if (t > tMax) return null
      if (t > tMin) tMin = t
    } else {
      if (t < tMin) return null
      if (t < tMax) tMax = t
    }
  }

  return [
    [x1 + tMin * dx, y1 + tMin * dy],
    [x1 + tMax * dx, y1 + tMax * dy]
  ]
}

// origin: [lon, lat]; extent: [west, south, east, north]. Returns
// [[lon, lat], [lon, lat]] for MapPanel's azimuthLine field, or null when
// the projected line doesn't reach the extent at all (origin far outside
// it -- shouldn't happen given the backend's 500m plausibility check, but
// cheap to guard).
export function azimuthLine(origin, azimuthDeg, extent) {
  const diagonalKm = haversineKm([extent[0], extent[1]], [extent[2], extent[3]])
  const end = destination(origin, diagonalKm, azimuthDeg, { units: 'kilometers' })
  const endCoords = end.geometry.coordinates

  const clipped = clipLineToBbox(origin, endCoords, extent)
  if (!clipped) return null
  return [origin, clipped[1]]
}
