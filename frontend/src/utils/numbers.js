// Strict numeric parsing shared by the tilt-model helpers (tiltModel.js) and the
// vector helpers (vectors.js). Split out so neither has to import the other.

const NUMBER_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

// Strict numeric parse for the text inputs (exponent notation must work, which
// type="number" mangles in some browsers). Returns a finite number, or null for
// anything else: '' (Number('') is 0, which would silently pass), whitespace,
// 'abc', hex, 'Infinity', '1,5'.
export function parseFiniteNumber(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!NUMBER_PATTERN.test(trimmed)) return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

// A finite number > 0, or null.
export function parsePositiveNumber(text) {
  const n = parseFiniteNumber(text)
  return n !== null && n > 0 ? n : null
}

// Which curvature form a quadratic (a global profile, or a vector's custom tilt
// -- both use the same field names) is using: 'secondGradient' unless 'rate'.
export function curvatureForm(source) {
  return source.curvatureInput === 'rate' ? 'rate' : 'secondGradient'
}

// The active second-gradient inputs as numbers, or null unless both are valid.
export function parseSecondGradient(source) {
  const gradient = parseFiniteNumber(source.secondGradient)
  const distanceKm = parsePositiveNumber(source.secondGradientDistanceKm)
  return gradient !== null && distanceKm !== null ? { gradient, distanceKm } : null
}
