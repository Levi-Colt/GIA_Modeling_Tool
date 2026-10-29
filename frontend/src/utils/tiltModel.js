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
// Spec 5 adds a second direction source, 'vectors' (utils/vectors.js), and spec 6
// a third, 'points' (utils/shorePoints.js): the dispatchers below (tiltModelIssues,
// buildTiltModel, describeTiltModel) branch on advanced.directionSource. In 'points'
// mode magnitude comes from the fitted surface, so no profile or hinge exists.
import { buildVectorsDirection, normalizeVectors, vectorIssues } from './vectors.js'
import { EXTRAPOLATIONS, SURFACE_HINGES, buildPointsDirection, normalizeShorePoints, pointIssues, surfaceOf } from './shorePoints.js'
import { parseFiniteNumber, parsePositiveNumber } from './numbers.js'
import { parseProfileFormula } from './formula.js'

// Re-exported so existing importers keep working.
export { parseFiniteNumber, parsePositiveNumber }

export const DIRECTION_SOURCES = [
  { value: 'azimuth', label: 'Single azimuth' },
  { value: 'vectors', label: 'Vectors' },
  { value: 'points', label: 'Shore points' }
]
export const DEFAULT_DIRECTION_SOURCE = 'azimuth'

export const FAMILIES = [
  { value: 'linear', label: 'Linear' },
  { value: 'quadratic', label: 'Quadratic' },
  { value: 'polynomial', label: 'Polynomial' }
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
  rateOfIncrease: '', // quadratic: the rate of increase of the gradient (m/km per km)
  formula: '' // polynomial: terms of a x^p (utils/formula.js)
}
export const DEFAULT_HINGE = { mode: 'origin', distanceKm: '' }

function parts(advanced) {
  return { profile: advanced?.profile ?? DEFAULT_PROFILE, hinge: advanced?.hinge ?? DEFAULT_HINGE }
}

export function directionSourceOf(advanced) {
  const source = advanced?.directionSource
  return source === 'vectors' || source === 'points' ? source : DEFAULT_DIRECTION_SOURCE
}

// True when the run is Advanced with the vectors direction source. Basic ignores
// every advanced field, so it is never "using vectors".
export function usingVectors(formState) {
  return formState.mode === 'advanced' && directionSourceOf(formState.advanced) === 'vectors'
}

// True when the run is Advanced with the shore-points direction source (no single
// azimuth, no gradient at the spillway, no profile or hinge).
export function usingPoints(formState) {
  return formState.mode === 'advanced' && directionSourceOf(formState.advanced) === 'points'
}

const vectorsOf = (advanced) => normalizeVectors(advanced?.vectors ?? [])

// Any stored hinge mode this version doesn't know (an older save's 'default' or
// 'natural', which spec 4a removed) is the default, 'origin'.
export function normalizeHingeMode(mode) {
  return mode === 'distance' || mode === 'none' ? mode : 'origin'
}

// Only the active family's fields are required.
function profileIssues(profile) {
  if (profile.family === 'quadratic') {
    return parseFiniteNumber(profile.rateOfIncrease) === null ? ['a rate of increase (a number)'] : []
  }
  if (profile.family === 'polynomial') {
    const parsed = parseProfileFormula(profile.formula)
    if (parsed.ok) return []
    return [String(profile.formula ?? '').trim() === '' ? 'a polynomial formula' : `a valid polynomial formula (${parsed.error})`]
  }
  return []
}

function hingeIssues(hinge) {
  return normalizeHingeMode(hinge.mode) === 'distance' && parsePositiveNumber(hinge.distanceKm) === null
    ? ['a hinge distance greater than 0']
    : []
}

// Reasons the tilt section isn't runnable, as plain strings (readiness.js keys
// them to the 'tilt' section). Only relevant in Advanced mode. In vectors mode the
// vectors are checked as well; the one profile and hinge always apply.
export function tiltModelIssues(advanced) {
  const { profile, hinge } = parts(advanced)
  if (directionSourceOf(advanced) === 'points') {
    return pointIssues(normalizeShorePoints(advanced?.shorePoints), surfaceOf(advanced))
  }
  if (directionSourceOf(advanced) === 'vectors') {
    return [...vectorIssues(vectorsOf(advanced)), ...profileIssues(profile), ...hingeIssues(hinge)]
  }
  return [...profileIssues(profile), ...hingeIssues(hinge)]
}

function buildProfile(profile) {
  return {
    family: profile.family,
    rate_of_increase: profile.family === 'quadratic' ? parseFiniteNumber(profile.rateOfIncrease) : null,
    formula: profile.family === 'polynomial' ? profile.formula.trim() : null
  }
}

// The API's `tilt_model` object. Only meaningful once tiltModelIssues is empty.
// Each family sends only its own field: a quadratic its rate, a polynomial its
// formula (the server parses it).
export function buildTiltModel(advanced) {
  const { profile, hinge } = parts(advanced)
  if (directionSourceOf(advanced) === 'points') {
    // No top-level profile or hinge: the API rejects them in this mode.
    return {
      version: 1,
      direction: buildPointsDirection(normalizeShorePoints(advanced?.shorePoints), surfaceOf(advanced))
    }
  }
  const mode = normalizeHingeMode(hinge.mode)
  const hingeOut = { mode, distance_km: mode === 'distance' ? parsePositiveNumber(hinge.distanceKm) : null }
  if (directionSourceOf(advanced) === 'vectors') {
    return {
      version: 1,
      direction: buildVectorsDirection(vectorsOf(advanced)),
      profile: buildProfile(profile),
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
// "Quadratic, k = 0.004 · hinge none, zero gradient at −54 km".
// hingeKm / hingeSource come from the latest profile preview; without them the
// guard clause is dropped. `fit` (points mode) is the latest fit's `selected`
// statistics, for the R² / RMSE clause.
export function describeTiltModel(advanced, hingeKm, hingeSource, fit) {
  const { profile, hinge } = parts(advanced)
  if (directionSourceOf(advanced) === 'points') {
    const surface = surfaceOf(advanced)
    const count = normalizeShorePoints(advanced?.shorePoints).length
    const stats =
      fit && Number.isFinite(fit.rmse_m)
        ? `, RMSE ${formatNumber(fit.rmse_m)} m${Number.isFinite(fit.r2) ? `, R² ${fit.r2.toFixed(3)}` : ''}`
        : ''
    const behind = SURFACE_HINGES.find((h) => h.value === surface.hinge)?.label.toLowerCase()
    const outside = EXTRAPOLATIONS.find((e) => e.value === surface.extrapolation)?.label.toLowerCase()
    return (
      `Order-${surface.order} surface from ${count} shore ${count === 1 ? 'point' : 'points'}${stats}` +
      ` · behind spillway: ${behind} · outside the data: ${outside}`
    )
  }
  const family = FAMILIES.find((f) => f.value === profile.family)?.label ?? profile.family
  let head = family
  if (profile.family === 'quadratic') head += `, k = ${profile.rateOfIncrease.trim()}`
  if (profile.family === 'polynomial') head += `, ${profile.formula.trim()}`

  if (directionSourceOf(advanced) === 'vectors') {
    const vectors = vectorsOf(advanced)
    const count = `${vectors.length} ${vectors.length === 1 ? 'vector' : 'vectors'}`
    head = `${count}, ${head.toLowerCase()}`
  }

  const mode = normalizeHingeMode(hinge.mode)
  let hingeText = { origin: 'at spillway', none: 'none' }[mode] ?? `${hinge.distanceKm.trim()} km behind spillway`
  if (hingeSource === 'guard' && Number.isFinite(hingeKm)) {
    hingeText += `, zero gradient at ${formatNumber(hingeKm)} km`
  }
  return `${head} · hinge ${hingeText}`
}
