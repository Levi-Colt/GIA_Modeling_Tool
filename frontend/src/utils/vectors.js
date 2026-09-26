// Vector-direction-field helpers (documentation/VECTOR_FIELD_SPEC.md, spec 5):
// the row model, validation/readiness, the `tilt_model.direction` payload, CSV
// import, the undo stack and the adapter to the map's `vectors` field. Pure
// functions, so readiness.js, payload.js, the table and the tests share one
// interpretation. Vector fields are kept as strings, like the rest of the form.
//
// Range is a vector's range of influence (how far its direction is trusted),
// never a magnitude; a custom tilt's gradient is *local* -- the gradient at that
// vector's own location.
import Papa from 'papaparse'
import { arrowLengthKm } from './geometry.js'
import { curvatureForm, parseFiniteNumber, parsePositiveNumber, parseSecondGradient } from './numbers.js'

export const MAX_VECTORS = 200
export const UNDO_LIMIT = 20

export const CUSTOM_FAMILIES = [
  { value: 'linear', label: 'Linear' },
  { value: 'quadratic', label: 'Quadratic' }
]

export const DEFAULT_CUSTOM = {
  family: 'linear',
  localGradient: '',
  curvatureInput: 'secondGradient', // same two forms as the global profile
  rateOfIncrease: '',
  secondGradient: '',
  secondGradientDistanceKm: ''
}

// Stable ids for React keys and for linking table rows to map arrows.
export function newId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `v_${crypto.randomUUID()}`
  return `v_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

export function newVector(patch = {}) {
  const { custom, ...rest } = patch
  return {
    id: newId(),
    lat: '',
    lon: '',
    azimuthDeg: '',
    rangeKm: '',
    tilt: 'global', // 'global' | 'custom'
    ...rest,
    custom: { ...DEFAULT_CUSTOM, ...(custom ?? {}) }
  }
}

// Vectors read back from localStorage: every row gets an id and every key its
// default, so a save from an older shape (or a hand-edited one) can't break the
// table.
export function normalizeVectors(list) {
  if (!Array.isArray(list)) return []
  return list.filter((v) => v && typeof v === 'object').map((v) => newVector({ ...v, id: v.id || newId() }))
}

export const isCustom = (v) => v.tilt === 'custom'
export const anyGlobal = (vectors) => vectors.some((v) => !isCustom(v))
export const allCustom = (vectors) => vectors.length > 0 && vectors.every(isCustom)

const inRange = (n, lo, hi) => n !== null && n >= lo && n <= hi

// One row's location/direction/range as numbers (null where invalid). `range`
// is { ok, value }: an empty range is fine (value null); a present one must be > 0.
export function parseVector(v) {
  const lat = parseFiniteNumber(v.lat)
  const lon = parseFiniteNumber(v.lon)
  const azimuth = parseFiniteNumber(v.azimuthDeg)
  const rangeText = String(v.rangeKm ?? '').trim()
  const range = rangeText === '' ? { ok: true, value: null } : { ok: parsePositiveNumber(rangeText) !== null, value: parsePositiveNumber(rangeText) }
  return {
    lat: inRange(lat, -90, 90) ? lat : null,
    lon: inRange(lon, -180, 180) ? lon : null,
    azimuth,
    range
  }
}

export const normalizeAzimuth = (deg) => ((deg % 360) + 360) % 360

// Whether a custom tilt has everything its family needs (only the active
// curvature form's fields count).
export function customIsComplete(custom) {
  if (parseFiniteNumber(custom.localGradient) === null) return false
  if (custom.family !== 'quadratic') return true
  return curvatureForm(custom) === 'rate'
    ? parseFiniteNumber(custom.rateOfIncrease) !== null
    : parseSecondGradient(custom) !== null
}

function rowsText(rows) {
  const shown = rows.slice(0, 6).join(', ')
  return `${rows.length === 1 ? 'vector' : 'vectors'} ${shown}${rows.length > 6 ? '…' : ''}`
}

// Reasons the vector list isn't runnable, as plain strings (readiness.js keys
// them to the 'tilt' section). Rows are the 1-based table numbers.
export function vectorIssues(vectors) {
  if (vectors.length === 0) return ['at least one vector']
  const issues = []
  if (vectors.length > MAX_VECTORS) issues.push(`no more than ${MAX_VECTORS} vectors`)
  const badPlace = []
  const badRange = []
  const badCustom = []
  vectors.forEach((v, i) => {
    const p = parseVector(v)
    if (p.lat === null || p.lon === null || p.azimuth === null) badPlace.push(i + 1)
    if (!p.range.ok) badRange.push(i + 1)
    if (isCustom(v) && !customIsComplete(v.custom)) badCustom.push(i + 1)
  })
  if (badPlace.length) issues.push(`a valid latitude, longitude and azimuth for ${rowsText(badPlace)}`)
  if (badRange.length) issues.push(`a range greater than 0 (or empty) for ${rowsText(badRange)}`)
  if (badCustom.length) issues.push(`a complete custom tilt for ${rowsText(badCustom)}`)
  return issues
}

// `tilt_model.direction` for vectors mode. Only meaningful once vectorIssues is
// empty. Range is null when empty; a quadratic custom tilt sends only its active
// curvature form; azimuths are normalized into [0, 360).
export function buildVectorsDirection(vectors) {
  return {
    type: 'vectors',
    vectors: vectors.map((v) => {
      const p = parseVector(v)
      let custom = null
      if (isCustom(v)) {
        const c = v.custom
        custom = { family: c.family, local_gradient: parseFiniteNumber(c.localGradient) }
        if (c.family === 'quadratic') {
          if (curvatureForm(c) === 'rate') {
            custom.rate_of_increase = parseFiniteNumber(c.rateOfIncrease)
          } else {
            const second = parseSecondGradient(c)
            custom.second_gradient = { gradient_m_per_km: second?.gradient ?? null, distance_km: second?.distanceKm ?? null }
          }
        }
      }
      return {
        lat: p.lat,
        lon: p.lon,
        azimuth_deg: p.azimuth === null ? null : normalizeAzimuth(p.azimuth),
        range_km: p.range.value,
        custom
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Map adapter and map-edit results.

// mapData.vectors: rows with a valid location. `azimuthDeg` is null while a
// row has none yet (a click-added vector), so it draws only its base handle.
// `number` is the 1-based table row, the arrow's label.
export function vectorsToMapData(vectors, selectedId, extent) {
  const out = []
  vectors.forEach((v, i) => {
    const p = parseVector(v)
    if (p.lat === null || p.lon === null) return
    out.push({
      id: v.id,
      number: i + 1,
      lon: p.lon,
      lat: p.lat,
      azimuthDeg: p.azimuth === null ? null : normalizeAzimuth(p.azimuth),
      rangeKm: p.range.value,
      lengthKm: arrowLengthKm(p.range.value, extent),
      selected: v.id === selectedId,
      custom: isCustom(v)
    })
  })
  return out
}

const fixed = (n, digits) => n.toFixed(digits)

// Map geometry (numbers) -> the row's string fields. Azimuth wraps into
// [0, 360) after rounding; a dragged range is at least 0.1 km.
export function fieldsFromGeometry({ lon, lat, azimuthDeg, rangeKm } = {}) {
  const out = {}
  if (Number.isFinite(lat)) out.lat = fixed(lat, 5)
  if (Number.isFinite(lon)) out.lon = fixed(lon, 5)
  if (Number.isFinite(azimuthDeg)) {
    const rounded = Math.round(normalizeAzimuth(azimuthDeg) * 10) / 10
    out.azimuthDeg = fixed(rounded >= 360 ? 0 : rounded, 1)
  }
  if (Number.isFinite(rangeKm)) out.rangeKm = fixed(Math.max(0.1, rangeKm), 1)
  return out
}

// ---------------------------------------------------------------------------
// Undo: the last UNDO_LIMIT vector-list states.

export function pushUndo(stack, snapshot, limit = UNDO_LIMIT) {
  const next = [...stack, snapshot]
  return next.length > limit ? next.slice(next.length - limit) : next
}

export function popUndo(stack) {
  if (stack.length === 0) return { stack, snapshot: null }
  return { stack: stack.slice(0, -1), snapshot: stack[stack.length - 1] }
}

// ---------------------------------------------------------------------------
// CSV import.

const HEADER_ALIASES = {
  lat: ['lat', 'latitude'],
  lon: ['lon', 'lng', 'long', 'longitude'],
  azimuth: ['azimuth', 'azimuth_deg', 'az'],
  range: ['range', 'range_km'],
  gradient: ['gradient', 'local_gradient'],
  rate: ['rate', 'rate_of_increase']
}

function findColumns(fields) {
  const cols = {}
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    cols[key] = fields.find((f) => aliases.includes(f)) ?? null
  }
  return cols
}

// Cell text, trimmed; '' for missing/empty.
const cell = (row, col) => (col && row[col] != null ? String(row[col]).trim() : '')

// Parses CSV text into vector rows. Matching is case-insensitive; a row with a
// gradient becomes a custom tilt (linear, or quadratic with a rate). Invalid
// rows are skipped whole -- never imported partially -- and reported with their
// data-row number (1 = the first row under the header).
//
// Returns { vectors, skipped: [{ row, reason }], error }. `error` is set (and
// nothing imported) when the file has no usable header/rows.
export function parseVectorsCsv(text) {
  const parsed = Papa.parse(text ?? '', {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim().toLowerCase()
  })
  const fields = parsed.meta?.fields ?? []
  const cols = findColumns(fields)
  const missing = ['lat', 'lon', 'azimuth'].filter((k) => !cols[k])
  if (fields.length === 0 || missing.length) {
    return {
      vectors: [],
      skipped: [],
      error: `The CSV needs ${missing.map((k) => ({ lat: 'a lat', lon: 'a lon', azimuth: 'an azimuth' })[k]).join(', ')} column${
        missing.length === 1 ? '' : 's'
      } (header names are matched without regard to case).`
    }
  }

  const vectors = []
  const skipped = []
  parsed.data.forEach((row, i) => {
    const rowNumber = i + 1
    const skip = (reason) => skipped.push({ row: rowNumber, reason })

    const check = (label, text, lo, hi) => {
      if (text === '') return `${label} missing`
      const n = parseFiniteNumber(text)
      if (n === null) return `${label} is not a number`
      if (lo !== undefined && (n < lo || n > hi)) return `${label} out of range`
      return null
    }
    const problem =
      check('latitude', cell(row, cols.lat), -90, 90) ||
      check('longitude', cell(row, cols.lon), -180, 180) ||
      check('azimuth', cell(row, cols.azimuth))
    if (problem) return skip(problem)

    const rangeText = cell(row, cols.range)
    if (rangeText !== '' && parsePositiveNumber(rangeText) === null) return skip('range must be greater than 0')

    const gradientText = cell(row, cols.gradient)
    const rateText = cell(row, cols.rate)
    if (gradientText !== '' && parseFiniteNumber(gradientText) === null) return skip('gradient is not a number')
    if (rateText !== '' && parseFiniteNumber(rateText) === null) return skip('rate is not a number')
    if (rateText !== '' && gradientText === '') return skip('rate given without a gradient')

    const azimuth = normalizeAzimuth(parseFiniteNumber(cell(row, cols.azimuth)))
    const custom =
      gradientText === ''
        ? {}
        : {
            family: rateText === '' ? 'linear' : 'quadratic',
            localGradient: gradientText,
            ...(rateText === '' ? {} : { curvatureInput: 'rate', rateOfIncrease: rateText })
          }
    vectors.push(
      newVector({
        lat: String(parseFiniteNumber(cell(row, cols.lat))),
        lon: String(parseFiniteNumber(cell(row, cols.lon))),
        azimuthDeg: String(Number(azimuth.toFixed(6))),
        rangeKm: rangeText,
        tilt: gradientText === '' ? 'global' : 'custom',
        custom
      })
    )
  })

  if (vectors.length === 0 && skipped.length === 0) return { vectors, skipped, error: 'The CSV has no data rows.' }
  return { vectors, skipped, error: null }
}

// "12 imported, 2 skipped: row 5 azimuth missing, row 9 latitude out of range"
// Also used for other CSV imports (shore points): `items` is the imported list.
export function describeImport({ vectors, items = vectors, skipped }) {
  const head = `${items.length} imported`
  if (skipped.length === 0) return head
  const shown = skipped.slice(0, 5).map((s) => `row ${s.row} ${s.reason}`)
  const more = skipped.length > 5 ? `, and ${skipped.length - 5} more` : ''
  return `${head}, ${skipped.length} skipped: ${shown.join(', ')}${more}`
}

// Replace or append, never past `limit` (MAX_VECTORS unless another list says so).
export function applyImport(existing, imported, mode, limit = MAX_VECTORS) {
  const next = mode === 'append' ? [...existing, ...imported] : [...imported]
  return next.slice(0, limit)
}

// Label for an isobase's relative uplift: "+40 m", "−20 m", "0 m".
export function isobaseLabel(uplift) {
  if (!Number.isFinite(uplift)) return ''
  const value = Number(Math.abs(uplift).toPrecision(6))
  if (value === 0) return '0 m'
  return `${uplift > 0 ? '+' : '−'}${value} m`
}
