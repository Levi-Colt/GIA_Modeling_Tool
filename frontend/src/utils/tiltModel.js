// Advanced-mode tilt model helpers (documentation/UPLIFT_MODEL_SPEC.md D5, as
// amended by UPLIFT_MODEL_CORRECTIONS_SPEC.md): numeric parsing for the text
// inputs, the `tilt_model` payload, readiness reasons, and the results-screen
// summary. Pure functions of `formState.advanced` so payload.js, readiness.js
// and the forms all agree on one interpretation.
//
// The tool is location-agnostic: nothing here (defaults, help text, labels,
// messages) may be tuned to, or point users toward, a particular paper or set of
// basins. Profile defaults are empty fields and the 'origin' hinge.

export const FAMILIES = [
  { value: 'linear', label: 'Linear' },
  { value: 'quadratic', label: 'Quadratic' },
  { value: 'polynomial', label: 'Polynomial' }
]

export const DEGREES = [2, 3, 4, 5]
export const MAX_DEGREE = 5

// Two ways to give a quadratic's curvature; the API converts a second gradient
// to the canonical rate of increase.
export const CURVATURE_INPUTS = [
  { value: 'secondGradient', label: 'Second gradient' },
  { value: 'rate', label: 'Rate of increase' }
]

// There is no family-dependent "default" hinge value: the default is 'origin'
// for every family, and the payload always sends an explicit mode.
export const HINGE_MODES = [
  { value: 'origin', label: 'At spillway (default)' },
  { value: 'distance', label: 'Distance behind spillway…' },
  { value: 'none', label: 'None: continue behind spillway' }
]

// Defaults for formState.advanced.profile / .hinge (ProcessingContext spreads
// these into its defaults; the helpers below fall back to them when a form
// state has no such keys).
export const DEFAULT_PROFILE = {
  family: 'linear',
  curvatureInput: 'secondGradient',
  rateOfIncrease: '',
  secondGradient: '',
  secondGradientDistanceKm: '',
  coefficients: ['', '', '', ''],
  degree: 3
}
export const DEFAULT_HINGE = { mode: 'origin', distanceKm: '' }

function parts(advanced) {
  return { profile: advanced?.profile ?? DEFAULT_PROFILE, hinge: advanced?.hinge ?? DEFAULT_HINGE }
}

// Any stored hinge mode this version doesn't know (an older save's 'default' or
// 'natural', which spec 4a removed) is the default, 'origin'.
export function normalizeHingeMode(mode) {
  return mode === 'distance' || mode === 'none' ? mode : 'origin'
}

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

// Number of c2..cN inputs the polynomial family shows / sends.
export function extraCoefficientCount(profile) {
  const degree = Number(profile.degree)
  return Math.min(Math.max(Number.isInteger(degree) ? degree : 3, 2), MAX_DEGREE) - 1
}

// Which curvature form a quadratic is using ('secondGradient' unless 'rate').
export function curvatureForm(profile) {
  return profile.curvatureInput === 'rate' ? 'rate' : 'secondGradient'
}

// The active second-gradient inputs as numbers, or null unless both are valid.
export function parseSecondGradient(profile) {
  const gradient = parseFiniteNumber(profile.secondGradient)
  const distanceKm = parsePositiveNumber(profile.secondGradientDistanceKm)
  return gradient !== null && distanceKm !== null ? { gradient, distanceKm } : null
}

// Reasons the tilt section isn't runnable, as plain strings (readiness.js keys
// them to the 'tilt' section). Only relevant in Advanced mode; only the active
// curvature form's fields are required.
export function tiltModelIssues(advanced) {
  const issues = []
  const { profile, hinge } = parts(advanced)
  if (profile.family === 'quadratic') {
    if (curvatureForm(profile) === 'rate') {
      if (parseFiniteNumber(profile.rateOfIncrease) === null) issues.push('a rate of increase (a number)')
    } else {
      if (parseFiniteNumber(profile.secondGradient) === null) issues.push('a second gradient (a number)')
      if (parsePositiveNumber(profile.secondGradientDistanceKm) === null) {
        issues.push('a distance for the second gradient (greater than 0)')
      }
    }
  }
  if (profile.family === 'polynomial') {
    const count = extraCoefficientCount(profile)
    const ok = profile.coefficients.slice(0, count).every((c) => parseFiniteNumber(c) !== null)
    if (!ok) issues.push(`polynomial coefficients c₂–c${count + 1} (numbers)`)
  }
  if (normalizeHingeMode(hinge.mode) === 'distance' && parsePositiveNumber(hinge.distanceKm) === null) {
    issues.push('a hinge distance greater than 0')
  }
  return issues
}

// The API's `tilt_model` object. Only meaningful once tiltModelIssues is empty.
// A quadratic sends only its active curvature form.
export function buildTiltModel(advanced) {
  const { profile, hinge } = parts(advanced)
  const mode = normalizeHingeMode(hinge.mode)
  const second = parseSecondGradient(profile)
  const useRate = curvatureForm(profile) === 'rate'
  return {
    version: 1,
    direction: { type: 'azimuth' },
    profile: {
      family: profile.family,
      rate_of_increase:
        profile.family === 'quadratic' && useRate ? parseFiniteNumber(profile.rateOfIncrease) : null,
      second_gradient:
        profile.family === 'quadratic' && !useRate
          ? { gradient_m_per_km: parseFiniteNumber(profile.secondGradient), distance_km: second?.distanceKm ?? null }
          : null,
      coefficients:
        profile.family === 'polynomial'
          ? profile.coefficients.slice(0, extraCoefficientCount(profile)).map(parseFiniteNumber)
          : null
    },
    hinge: { mode, distance_km: mode === 'distance' ? parsePositiveNumber(hinge.distanceKm) : null }
  }
}

// "-54" style number for display (U+2212 minus, up to `digits` significant
// digits, no trailing zeros).
export function formatNumber(value, digits = 3) {
  if (!Number.isFinite(value)) return ''
  const text = String(Number(value.toPrecision(digits)))
  return text.startsWith('-') ? `−${text.slice(1)}` : text
}

// Shown when the zero-gradient guard (not the hinge mode) sets the clamp. It is
// information, not a warning.
export function guardNote(hingeKm) {
  return (
    `The profile's gradient reaches zero ${formatNumber(Math.abs(hingeKm))} km behind the spillway; ` +
    'uplift is held constant beyond that point.'
  )
}

// Results-screen parameter line (Advanced only), e.g.
// "Quadratic, second gradient 1.2 m/km at 150 km · hinge none, zero gradient at −54 km".
// hingeKm / hingeSource come from the latest profile preview; without them the
// guard clause is dropped.
export function describeTiltModel(advanced, hingeKm, hingeSource) {
  const { profile, hinge } = parts(advanced)
  const family = FAMILIES.find((f) => f.value === profile.family)?.label ?? profile.family
  let head = family
  if (profile.family === 'quadratic') {
    head +=
      curvatureForm(profile) === 'rate'
        ? `, k = ${profile.rateOfIncrease.trim()}`
        : `, second gradient ${profile.secondGradient.trim()} m/km at ${profile.secondGradientDistanceKm.trim()} km`
  }
  if (profile.family === 'polynomial') head += `, degree ${extraCoefficientCount(profile) + 1}`

  const mode = normalizeHingeMode(hinge.mode)
  let hingeText = { origin: 'at spillway', none: 'none' }[mode] ?? `${hinge.distanceKm.trim()} km behind spillway`
  if (hingeSource === 'guard' && Number.isFinite(hingeKm)) {
    hingeText += `, zero gradient at ${formatNumber(hingeKm)} km`
  }
  return `${head} · hinge ${hingeText}`
}
