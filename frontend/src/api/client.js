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

  const blob = await res.blob()
  return { blob, reprojectedFrom, warnings, elevationSource, elevationNote }
}
