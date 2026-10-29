// Origin coordinates are decimal degrees only (FRONTEND_REVIEW item 6): the API
// reprojects every non-geographic DEM to EPSG:4326, so there is no case left for
// typing the origin in the raster's native CRS or an arbitrary EPSG.

// "45.25000N, 110.55000W" -- the hemisphere-annotated form /api/resolve-point and
// /api/process parse. Longitude wraps into [-180, 180] first (a map panned past the
// antimeridian reports values outside it).
export function formatDecimalDegrees(lon, lat, digits = 5) {
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180
  const ns = lat < 0 ? 'S' : 'N'
  const ew = wrapped < 0 ? 'W' : 'E'
  return `${Math.abs(lat).toFixed(digits)}${ns}, ${Math.abs(wrapped).toFixed(digits)}${ew}`
}

// The numbers a formatted string carries, so a map pick can show the marker at
// exactly the typed value without a round trip.
export function roundedLonLat(lon, lat, digits = 5) {
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180
  return [Number(wrapped.toFixed(digits)), Number(lat.toFixed(digits))]
}
