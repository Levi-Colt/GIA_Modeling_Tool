// Split out from App.jsx so it can be unit-tested without pulling in the
// rest of App.jsx's module graph (MapPanel -> georaster-layer-for-leaflet,
// heavy and irrelevant to this pure gating logic).

// UX nicety only — not a substitute for the backend's own 422 validation.
export function isReadyToRun(formState) {
  if (formState.preflightStatus !== 'valid') return false
  if (!formState.originValue) return false
  if (formState.originMode === 'epsg' && !formState.originEpsg) return false
  if (!formState.tiltAzimuth || !formState.tiltFactor || !formState.targetElevation) return false
  // 'checking' means a blur-triggered check is in flight; 'idle' means one
  // hasn't resolved yet for the coordinate currently in the field --
  // either the field was never blurred, or it was edited since the last
  // check invalidated it (see CoordinateSteps.jsx's onChange handlers).
  // Without this, a stale targetElevation left over from an earlier,
  // already-edited-away coordinate would otherwise still pass the
  // non-empty check above.
  if (formState.elevationCheckStatus === 'checking') return false
  if (formState.elevationCheckStatus === 'idle') return false
  return true
}
