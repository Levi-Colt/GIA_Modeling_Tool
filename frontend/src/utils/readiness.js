// Split out from App.jsx so it can be unit-tested without pulling in the
// rest of App.jsx's module graph (MapPanel -> georaster-layer-for-leaflet,
// heavy and irrelevant to this pure gating logic).
import { tiltModelIssues, usingVectors } from './tiltModel.js'
import { anyGlobal, normalizeVectors } from './vectors.js'

// The optional selection radius (km): '' means "no limit"; anything else must
// be a finite number > 0. Returns that number, or null when empty/invalid.
export function parseSelectionRadiusKm(value) {
  if (value === '' || value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

// UX nicety only — not a substitute for the backend's own 422 validation.
// Returns { ready, missing, missingText }. `missing` is a list of
// { section, text } reasons in the order the form asks for them, where
// `section` is an Advanced-form section key ('dem' | 'origin' | 'tilt' |
// 'output') so each section header can show its own "Needs: ..." line;
// `missingText` is the plain string list for the footer's "Still needed" line.
export function getReadiness(formState) {
  const missing = []
  const need = (section, text) => missing.push({ section, text })

  if (formState.preflightStatus !== 'valid') need('dem', 'a valid DEM')
  if (!formState.originValue) need('origin', 'origin coordinates')
  if (formState.originMode === 'epsg' && !formState.originEpsg) need('origin', 'origin EPSG code')
  if (usingVectors(formState)) {
    // Vectors mode (Advanced only): no single azimuth, and the gradient at the
    // spillway is needed only while some vector uses the global profile.
    const vectors = normalizeVectors(formState.advanced.vectors)
    if (anyGlobal(vectors) && !formState.tiltFactor) need('tilt', 'the global gradient at the spillway')
  } else {
    if (!formState.tiltAzimuth) need('tilt', 'tilt azimuth')
    if (!formState.tiltFactor) need('tilt', 'tilt factor')
  }
  // Target elevation and the origin elevation check both live in the Origin
  // section (target elevation is DEM-authoritative at the origin).
  if (!formState.targetElevation) need('origin', 'target elevation')
  // 'checking' means a blur-triggered check is in flight; 'idle' means one
  // hasn't resolved yet for the coordinate currently in the field --
  // either the field was never blurred, or it was edited since the last
  // check invalidated it (see CoordinateSteps.jsx's onChange handlers).
  // Without this, a stale targetElevation left over from an earlier,
  // already-edited-away coordinate would otherwise still pass the
  // non-empty check above.
  if (formState.elevationCheckStatus === 'checking') {
    need('origin', 'origin elevation check in progress')
  } else if (formState.elevationCheckStatus === 'idle') {
    need('origin', 'origin elevation check (click out of the coordinate field)')
  }
  const radius = formState.selectionRadiusKm
  if (radius !== '' && radius != null && parseSelectionRadiusKm(radius) === null) {
    need('output', 'a positive selection radius (or leave it empty)')
  }

  if (formState.mode === 'advanced') {
    // Advanced-only checks (keyed to 'tilt'). They must never run for Basic:
    // advanced-only fields can't affect a Basic run's readiness. Later specs
    // (shore points) append their own here; vectors are covered by tiltModelIssues.
    for (const text of tiltModelIssues(formState.advanced)) need('tilt', text)
  }

  return { ready: missing.length === 0, missing, missingText: missing.map((m) => m.text) }
}

export function isReadyToRun(formState) {
  return getReadiness(formState).ready
}
