// Split out from App.jsx so it can be unit-tested without pulling in the
// rest of App.jsx's module graph (MapPanel -> georaster-layer-for-leaflet,
// heavy and irrelevant to this pure gating logic).

// The optional selection radius (km): '' means "no limit"; anything else must
// be a finite number > 0. Returns that number, or null when empty/invalid.
export function parseSelectionRadiusKm(value) {
  if (value === '' || value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

// UX nicety only — not a substitute for the backend's own 422 validation.
// Returns { ready, missing }, where `missing` is a list of short, user-facing
// reasons in the order the form asks for them.
export function getReadiness(formState) {
  const missing = []
  if (formState.preflightStatus !== 'valid') missing.push('a valid DEM')
  if (!formState.originValue) missing.push('origin coordinates')
  if (formState.originMode === 'epsg' && !formState.originEpsg) missing.push('origin EPSG code')
  if (!formState.tiltAzimuth) missing.push('tilt azimuth')
  if (!formState.tiltFactor) missing.push('tilt factor')
  if (!formState.targetElevation) missing.push('target elevation')
  // 'checking' means a blur-triggered check is in flight; 'idle' means one
  // hasn't resolved yet for the coordinate currently in the field --
  // either the field was never blurred, or it was edited since the last
  // check invalidated it (see CoordinateSteps.jsx's onChange handlers).
  // Without this, a stale targetElevation left over from an earlier,
  // already-edited-away coordinate would otherwise still pass the
  // non-empty check above.
  if (formState.elevationCheckStatus === 'checking') {
    missing.push('origin elevation check in progress')
  } else if (formState.elevationCheckStatus === 'idle') {
    missing.push('origin elevation check (click out of the coordinate field)')
  }
  const radius = formState.selectionRadiusKm
  if (radius !== '' && radius != null && parseSelectionRadiusKm(radius) === null) {
    missing.push('a positive selection radius (or leave it empty)')
  }
  return { ready: missing.length === 0, missing }
}

export function isReadyToRun(formState) {
  return getReadiness(formState).ready
}
