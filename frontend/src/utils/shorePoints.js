// Shore-point uplift surface helpers (documentation/SHORE_POINT_SURFACE_SPEC.md,
// spec 6): the row model, readiness, the `tilt_model.direction` payload, CSV
// parsing with a column mapping, and the adapter to the map's `shorePoints`
// field. Pure functions, so readiness.js, payload.js, the panel, the fit hook and
// the tests share one interpretation. Point fields are kept as strings, like the
// rest of the form (and like utils/vectors.js).
//
// A point is a place and the present elevation of a shoreline feature there. The
// fitted surface is a smooth trend through them (order 1, 2 or 3); its magnitude
// comes from the data, so no profile or hinge applies in this mode.
import Papa from 'papaparse'
import { parseFiniteNumber } from './numbers.js'

export const MAX_SHORE_POINTS = 5000
export const MAX_LABEL_LENGTH = 100
export const SURFACE_ORDERS = [1, 2, 3]

// Defaults for formState.advanced.surface (ProcessingContext spreads this in).
export const DEFAULT_SURFACE = { order: 2, hinge: 'none', extrapolation: 'warn' }

export const SURFACE_HINGES = [
  { value: 'none', label: 'Apply surface as fitted' },
  { value: 'origin', label: 'No change behind origin' }
]
export const EXTRAPOLATIONS = [
  { value: 'warn', label: 'Warn' },
  { value: 'mask', label: 'Mask (no contours)' }
]

// Terms of a bivariate polynomial of each order, and the fewest points a fit
// needs (terms + 3). The API enforces the same numbers.
const TERMS = { 1: 3, 2: 6, 3: 10 }
export const minPointsForOrder = (order) => (TERMS[order] ?? TERMS[2]) + 3
export const feasibleOrders = (count) => SURFACE_ORDERS.filter((o) => count >= minPointsForOrder(o))

// advanced.surface with every key valid (an older or hand-edited save can't break it).
export function surfaceOf(advanced) {
  const s = advanced?.surface ?? {}
  return {
    order: SURFACE_ORDERS.includes(s.order) ? s.order : DEFAULT_SURFACE.order,
    hinge: s.hinge === 'origin' ? 'origin' : 'none',
    extrapolation: s.extrapolation === 'mask' ? 'mask' : 'warn'
  }
}

// ---------------------------------------------------------------------------
// The row model.

export function newPointId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `p_${crypto.randomUUID()}`
  return `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

export function newShorePoint(patch = {}) {
  return { id: newPointId(), lat: '', lon: '', elevationM: '', label: '', ...patch }
}

// Points read back from localStorage: every row gets an id and all its keys.
export function normalizeShorePoints(list) {
  if (!Array.isArray(list)) return []
  return list
    .filter((p) => p && typeof p === 'object')
    .map((p) => newShorePoint({ ...p, id: p.id || newPointId() }))
}

const inRange = (n, lo, hi) => n !== null && n >= lo && n <= hi

// One row as numbers (null where invalid); the label is the trimmed text.
export function parseShorePoint(p) {
  const lat = parseFiniteNumber(p.lat)
  const lon = parseFiniteNumber(p.lon)
  return {
    lat: inRange(lat, -90, 90) ? lat : null,
    lon: inRange(lon, -180, 180) ? lon : null,
    elevation: parseFiniteNumber(p.elevationM),
    label: String(p.label ?? '').trim()
  }
}

export const isValidPoint = (p) => {
  const r = parseShorePoint(p)
  return r.lat !== null && r.lon !== null && r.elevation !== null
}

function rowsText(rows) {
  const shown = rows.slice(0, 6).join(', ')
  return `${rows.length === 1 ? 'point' : 'points'} ${shown}${rows.length > 6 ? '…' : ''}`
}

// Reasons the points aren't runnable, as plain strings (readiness.js keys them to
// the 'tilt' section): enough points for the chosen order, all of them valid.
// Rows are the 1-based table numbers.
export function pointIssues(points, surface) {
  const order = surface?.order ?? DEFAULT_SURFACE.order
  const need = minPointsForOrder(order)
  const issues = []
  if (points.length > MAX_SHORE_POINTS) issues.push(`no more than ${MAX_SHORE_POINTS} shore points`)
  else if (points.length < need) {
    issues.push(`at least ${need} shore points for an order-${order} surface (or choose a lower order)`)
  }
  const bad = []
  points.forEach((p, i) => {
    if (!isValidPoint(p)) bad.push(i + 1)
  })
  if (bad.length) issues.push(`a valid latitude, longitude and elevation for ${rowsText(bad)}`)
  return issues
}

// `tilt_model.direction` for points mode. Only meaningful once pointIssues is
// empty. The label is sent only when present, so shore_points.csv in the result
// keeps the site names.
export function buildPointsDirection(points, surface) {
  return {
    type: 'points',
    points: points.map((p) => {
      const r = parseShorePoint(p)
      return {
        lat: r.lat,
        lon: r.lon,
        elevation_m: r.elevation,
        ...(r.label !== '' ? { label: r.label.slice(0, MAX_LABEL_LENGTH) } : {})
      }
    }),
    order: surface.order,
    hinge: surface.hinge,
    extrapolation: surface.extrapolation
  }
}

// The POST /api/fit-uplift-surface body, or null while it can't be asked: the
// points must be runnable and the origin and DEM bounds known (the fit's frame
// depends on the DEM's extent).
export function buildFitBody(advanced, origin, bounds) {
  const points = normalizeShorePoints(advanced?.shorePoints)
  const surface = surfaceOf(advanced)
  if (pointIssues(points, surface).length || !origin || !bounds) return null
  const { points: sent, order, hinge, extrapolation } = buildPointsDirection(points, surface)
  return { points: sent, order, origin, bounds_wgs84: bounds, hinge, extrapolation }
}

// ---------------------------------------------------------------------------
// Map adapter.

// mapData.shorePoints: rows with a valid location. `fit` is the selected fit
// ({ residuals_m, outlier_indices }) for exactly these rows, or null (the point is
// then drawn neutral). Residuals are aligned by row index: a fit only exists while
// every row is valid, so the indexes agree.
export function shorePointsToMapData(points, fit) {
  const outliers = new Set(fit?.outlier_indices ?? [])
  const out = []
  points.forEach((p, i) => {
    const r = parseShorePoint(p)
    if (r.lat === null || r.lon === null) return
    const residual = fit?.residuals_m?.[i]
    out.push({
      id: p.id,
      lon: r.lon,
      lat: r.lat,
      elevationM: r.elevation,
      residualM: Number.isFinite(residual) ? residual : null,
      outlier: outliers.has(i),
      label: r.label
    })
  })
  return out
}

// "331 m" -- an isobase's absolute elevation (m a.s.l.).
export function elevationLabel(elevation) {
  if (!Number.isFinite(elevation)) return ''
  const text = String(Number(Math.abs(elevation).toPrecision(6)))
  return `${elevation < 0 ? '−' : ''}${text} m`
}

// ---------------------------------------------------------------------------
// CSV import.
//
// Supplementary spreadsheets have many columns and inconsistent names, so columns
// are matched by header first (case-insensitively) and, when lat/lon/elevation
// can't all be matched, the caller shows a picker over the file's own headers and
// calls parseShorePointsCsv again with the chosen mapping. Columns are addressed
// by index, so duplicate or blank headers work.

export const POINT_FIELDS = [
  { key: 'lat', label: 'Latitude', required: true },
  { key: 'lon', label: 'Longitude', required: true },
  { key: 'elevation', label: 'Elevation (m)', required: true },
  { key: 'label', label: 'Site name (optional)', required: false }
]

const HEADER_ALIASES = {
  lat: ['lat', 'latitude'],
  lon: ['lon', 'lng', 'long', 'longitude'],
  elevation: ['elevation', 'elev', 'elevation_m', 'z', 'height'],
  label: ['site', 'name', 'site_name', 'label']
}

// { lat, lon, elevation, label }: a column index, or null when no header matched.
export function autoMapColumns(headers) {
  const lower = headers.map((h) => String(h ?? '').trim().toLowerCase())
  const mapping = {}
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const i = lower.findIndex((h) => aliases.includes(h))
    mapping[key] = i === -1 ? null : i
  }
  return mapping
}

const cell = (row, index) => (index !== null && index !== undefined && row[index] != null ? String(row[index]).trim() : '')

// Parses CSV text into point rows. Invalid rows are skipped whole -- never
// imported partially -- and reported with their data-row number (1 = the first row
// under the header).
//
// Returns { items, skipped: [{ row, reason }], error, columns, needsMapping }.
// `columns` ({ headers, preview (first 5 data rows), mapping, fields }) is always
// present for a readable file; `needsMapping` is true (and nothing imported) while a
// required column has no match -- call again with `mapping`.
export function parseShorePointsCsv(text, mapping) {
  const parsed = Papa.parse(text ?? '', { header: false, skipEmptyLines: 'greedy' })
  const table = parsed.data
  if (table.length === 0) return { items: [], skipped: [], error: 'The CSV is empty.', columns: null, needsMapping: false }

  const headers = table[0].map((h) => String(h ?? '').trim())
  const rows = table.slice(1)
  const map = mapping ?? autoMapColumns(headers)
  const columns = { headers, preview: rows.slice(0, 5), mapping: map, fields: POINT_FIELDS }

  const missing = POINT_FIELDS.filter((f) => f.required && (map[f.key] === null || map[f.key] === undefined))
  if (missing.length) return { items: [], skipped: [], error: null, columns, needsMapping: true }
  if (rows.length === 0) return { items: [], skipped: [], error: 'The CSV has no data rows.', columns, needsMapping: false }

  const items = []
  const skipped = []
  rows.forEach((row, i) => {
    const rowNumber = i + 1
    const skip = (reason) => skipped.push({ row: rowNumber, reason })
    const check = (label, text, lo, hi) => {
      if (text === '') return `${label} missing`
      const n = parseFiniteNumber(text)
      if (n === null) return `${label} is not a number`
      if (lo !== undefined && (n < lo || n > hi)) return `${label} out of range`
      return null
    }
    const latText = cell(row, map.lat)
    const lonText = cell(row, map.lon)
    const elevText = cell(row, map.elevation)
    const problem =
      check('latitude', latText, -90, 90) || check('longitude', lonText, -180, 180) || check('elevation', elevText)
    if (problem) return skip(problem)
    items.push(
      newShorePoint({
        lat: String(parseFiniteNumber(latText)),
        lon: String(parseFiniteNumber(lonText)),
        elevationM: String(parseFiniteNumber(elevText)),
        label: cell(row, map.label).slice(0, MAX_LABEL_LENGTH)
      })
    )
  })
  return { items, skipped, error: null, columns, needsMapping: false }
}
