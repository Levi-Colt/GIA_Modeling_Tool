import { unzipSync } from 'fflate'

// IMPORTANT: never prefix these with a leading slash. A leading slash
// resolves from the domain root, which breaks under jupyter-server-proxy's
// per-user path prefix (/user/<name>/proxy/<port>/...). No leading slash
// means the browser resolves it relative to the current document URL,
// which already includes whatever prefix it's served under — in dev, in
// production, and under CryoCloud, with no environment-specific config.
const API_BASE = 'api/'

export async function runPreflight(file, path) {
  const form = new FormData()
  if (file) form.append('dem_file', file)
  if (path) form.append('file_path', path)

  const res = await fetch(`${API_BASE}preflight`, {
    method: 'POST',
    body: form
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}))
    throw new Error(detail.detail || 'Preflight check failed')
  }
  return res.json()
}

export async function rasterPreview(file, path) {
  const form = new FormData()
  if (file) form.append('dem_file', file)
  if (path) form.append('file_path', path)

  const res = await fetch(`${API_BASE}raster-preview`, {
    method: 'POST',
    body: form
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}))
    throw new Error(detail.detail || 'Raster preview failed')
  }
  return res.arrayBuffer()
}

export async function resolvePoint(originMode, originValue, originEpsg, nativeCrs) {
  const res = await fetch(`${API_BASE}resolve-point`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origin_mode: originMode,
      origin_value: originValue,
      origin_epsg: originEpsg || null,
      native_crs: nativeCrs || null
    })
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}))
    throw new Error(detail.detail || 'Could not resolve origin point')
  }
  return res.json()
}

export async function originElevation(file, path, originMode, originValue, originEpsg) {
  const form = new FormData()
  if (file) form.append('dem_file', file)
  if (path) form.append('file_path', path)
  form.append('origin_mode', originMode)
  form.append('origin_value', originValue)
  if (originEpsg) form.append('origin_epsg', originEpsg)

  const res = await fetch(`${API_BASE}origin-elevation`, {
    method: 'POST',
    body: form
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}))
    throw new Error(detail.detail || 'Origin elevation check failed')
  }
  return res.json()
}

export async function runProcess(payload) {
  const form = new FormData()
  Object.entries(payload).forEach(([key, value]) => {
    if (value !== undefined && value !== null) form.append(key, value)
  })

  const res = await fetch(`${API_BASE}process`, {
    method: 'POST',
    body: form
  })

  const reprojectedFrom = res.headers.get('X-Source-CRS-Reprojected-From')
  const warnings = res.headers.get('X-Processing-Warnings')
  const elevationSource = res.headers.get('X-Target-Elevation-Source')
  const elevationNote = res.headers.get('X-Target-Elevation-Note')

  if (!res.ok) {
    const detail = await res.json().catch(() => ({}))
    throw new Error(detail.detail || 'Processing failed')
  }

  // Response body is now a zip bundle (strandlines.gpkg + contour.geojson +
  // optional preview_tilted.tif), not a bare .gpkg -- see
  // documentation/VISUALIZATION_PIPELINE_SPEC.md Stage 3. Unzip client-side with fflate;
  // the .gpkg bytes stay a Blob for the existing download flow, contour
  // parses straight to GeoJSON, and preview_tilted.tif (when present) is
  // handed back as raw bytes for the caller to parse with georaster
  // (kept async, one level up, alongside Stage 2's raster parsing).
  const arrayBuffer = await res.arrayBuffer()
  const files = unzipSync(new Uint8Array(arrayBuffer))

  const blob = new Blob([files['strandlines.gpkg']], { type: 'application/geopackage+sqlite3' })
  const contour = files['contour.geojson']
    ? JSON.parse(new TextDecoder().decode(files['contour.geojson']))
    : null
  // .slice() copies into a freshly-allocated buffer -- fflate's entries are
  // views into one shared buffer for the whole zip, so handing out the raw
  // .buffer as-is would leak neighboring entries' bytes alongside it.
  const tiltedRasterBytes = files['preview_tilted.tif']
    ? files['preview_tilted.tif'].slice().buffer
    : null

  return { blob, contour, tiltedRasterBytes, reprojectedFrom, warnings, elevationSource, elevationNote }
}
