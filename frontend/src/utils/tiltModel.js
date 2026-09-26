// Advanced-mode tilt model helpers (documentation/UPLIFT_MODEL_SPEC.md D5, as
// amended by UPLIFT_MODEL_CORRECTIONS_SPEC.md): numeric parsing for the text
// inputs, the `tilt_model` payload, readiness reasons, and the results-screen
// summary. Pure functions of `formState.advanced` so payload.js, readiness.js
// and the forms all agree on one interpretation.
//
// The tool is location-agnostic: nothing here (defaults, help text, labels,
// messages) may be tuned to, or point users toward, a particular paper or set of
// basins. Profile defaults are empty fields and the 'origin' hinge.
//
// Spec 5 adds a second direction source, 'vectors' (utils/vectors.js): the
// dispatchers below (tiltModelIssues, buildTiltModel, describeTiltModel) branch
// on advanced.directionSource.
import { anyGlobal, buildVectorsDirection, isCustom, normalizeVectors, vectorIssues } from './vectors.js'
import { curvatureForm, parseFiniteNumber, parsePositiveNumber, parseSecondGradient } from './numbers.js'

// Re-exported so existing importers keep working.
export { curvatureForm, parseFiniteNumber, parsePositiveNumber, parseSecondGradient }

export const DIRECTION_SOURCES = [
  { value: 'azimuth', label: 'Single azimuth' },
  { value: 'vectors', label: 'Vectors' }
]
export const DEFAULT_DIRECTION_SOURCE = 'azimuth'

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

export function directionSourceOf(advanced) {
  return advanced?.directionSource === 'vectors' ? 'vectors' : DEFAULT_DIRECTION_SOURCE
}

// True when the run is Advanced with the vectors direction source. Basic ignores
// every advanced field, so it is never "using vectors".
export function usingVectors(formState) {
  return formState.mode === 'advanced' && directionSourceOf(formState.advanced) === 'vectors'
}

const vectorsOf = (advanced) => normalizeVectors(advanced?.vectors ?? [])

// Any stored hinge mode this version doesn't know (an older save's 'default' or
// 'natural', which spec 4a removed) is the default, 'origin'.
export function normalizeHingeMode(mode) {
  return mode === 'distance' || mode === 'none' ? mode : 'origin'
}

// Number of c2..cN inputs the polynomial family shows / sends.
export function extraCoefficientCount(profile) {
  const degree = Number(profile.degree)
  return Math.min(Math.max(Number.isInteger(degree) ? degree : 3, 2), MAX_DEGREE) - 1
}

// Only the active curvature form's fields are required.
function profileIssues(profile) {
  const issues = []
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
  return issues
}

function hingeIssues(hinge) {
  return normalizeHingeMode(hinge.mode) === 'distance' && parsePositiveNumber(hinge.distanceKm) === null
    ? ['a hinge distance greater than 0']
    : []
}

// Reasons the tilt section isn't runnable, as plain strings (readiness.js keys
// them to the 'tilt' section). Only relevant in Advanced mode. In vectors mode the
// global profile's fields count only while some vector uses the global profile;
// the hinge always applies.
export function tiltModelIssues(advanced) {
  const { profile, hinge } = parts(advanced)
  if (directionSourceOf(advanced) === 'vectors') {
    const vectors = vectorsOf(advanced)
    return [
      ...vectorIssues(vectors),
      ...(anyGlobal(vectors) ? profileIssues(profile) : []),
      ...hingeIssues(hinge)
    ]
  }
  return [...profileIssues(profile), ...hingeIssues(hinge)]
}

function buildProfile(profile) {
  const second = parseSecondGradient(profile)
  const useRate = curvatureForm(profile) === 'rate'
  return {
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
  }
}

// The API's `tilt_model` object. Only meaningful once tiltModelIssues is empty.
// A quadratic sends only its active curvature form. In vectors mode the global
// profile is omitted when every vector is custom (it is unused, and there is no
// gradient at the spillway to build it from).
export function buildTiltModel(advanced) {
  const { profile, hinge } = parts(advanced)
  const mode = normalizeHingeMode(hinge.mode)
  const hingeOut = { mode, distance_km: mode === 'distance' ? parsePositiveNumber(hinge.distanceKm) : null }
  if (directionSourceOf(advanced) === 'vectors') {
    const vectors = vectorsOf(advanced)
    return {
      version: 1,
      direction: buildVectorsDirection(vectors),
      ...(anyGlobal(vectors) ? { profile: buildProfile(profile) } : {}),
      hinge: hingeOut
    }
  }
  return { version: 1, direction: { type: 'azimuth' }, profile: buildProfile(profile), hinge: hingeOut }
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

  if (directionSourceOf(advanced) === 'vectors') {
    const vectors = vectorsOf(advanced)
    const custom = vectors.filter(isCustom).length
    const count = `${vectors.length} ${vectors.length === 1 ? 'vector' : 'vectors'}`
    head = `${count}${custom ? ` (${custom} custom)` : ''}${anyGlobal(vectors) ? `, global ${head.toLowerCase()}` : ''}`
  }

  const mode = normalizeHingeMode(hinge.mode)
  let hingeText = { origin: 'at spillway', none: 'none' }[mode] ?? `${hinge.distanceKm.trim()} km behind spillway`
  if (hingeSource === 'guard' && Number.isFinite(hingeKm)) {
    hingeText += `, zero gradient at ${formatNumber(hingeKm)} km`
  }
  return `${head} · hinge ${hingeText}`
}
