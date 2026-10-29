// Vector-direction-field helpers (documentation/VECTOR_FIELD_SPEC.md, spec 5):
// the row model, validation/readiness, the `tilt_model.direction` payload,
// the undo stack and the adapter to the map's `vectors` field. Pure
// functions, so readiness.js, payload.js, the table and the tests share one
// interpretation. Vector fields are kept as strings, like the rest of the form.
//
// Range is a vector's range of influence (how far its direction is trusted),
// never a magnitude. Vectors only give directions: the magnitude always comes from
// the one global profile (there are no per-vector tilts).
import { arrowLengthKm } from './geometry.js'
import { parseFiniteNumber, parsePositiveNumber } from './numbers.js'

export const MAX_VECTORS = 200
export const UNDO_LIMIT = 20

// Stable ids for React keys and for linking table rows to map arrows.
export function newId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `v_${crypto.randomUUID()}`
  return `v_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

export function newVector(patch = {}) {
  // Older saves carried a per-vector tilt ('global' | 'custom' and its parameters);
  // that no longer exists, so any such keys are dropped.
  // eslint-disable-next-line no-unused-vars
  const { tilt, custom, ...rest } = patch
  return {
    id: newId(),
    lat: '',
    lon: '',
    azimuthDeg: '',
    rangeKm: '',
    ...rest
  }
}

// Vectors read back from localStorage: every row gets an id and every key its
// default, so a save from an older shape (or a hand-edited one) can't break the
// table.
export function normalizeVectors(list) {
  if (!Array.isArray(list)) return []
  return list.filter((v) => v && typeof v === 'object').map((v) => newVector({ ...v, id: v.id || newId() }))
}

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
  vectors.forEach((v, i) => {
    const p = parseVector(v)
    if (p.lat === null || p.lon === null || p.azimuth === null) badPlace.push(i + 1)
    if (!p.range.ok) badRange.push(i + 1)
  })
  if (badPlace.length) issues.push(`a valid latitude, longitude and azimuth for ${rowsText(badPlace)}`)
  if (badRange.length) issues.push(`a range greater than 0 (or empty) for ${rowsText(badRange)}`)
  return issues
}

// `tilt_model.direction` for vectors mode. Only meaningful once vectorIssues is
// empty. Range is null when empty; azimuths are normalized into [0, 360).
export function buildVectorsDirection(vectors) {
  return {
    type: 'vectors',
    vectors: vectors.map((v) => {
      const p = parseVector(v)
      return {
        lat: p.lat,
        lon: p.lon,
        azimuth_deg: p.azimuth === null ? null : normalizeAzimuth(p.azimuth),
        range_km: p.range.value
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
      selected: v.id === selectedId
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
// Import reporting, shared with the shore-point CSV import (vectors themselves
// are drawn on the map and have no import).

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
