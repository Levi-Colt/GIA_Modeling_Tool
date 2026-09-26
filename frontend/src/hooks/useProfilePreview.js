import { useEffect, useRef } from 'react'
import { useProcessing } from '../context/ProcessingContext.jsx'
import { profilePreview } from '../api/client.js'
import { getReadiness } from '../utils/readiness.js'
import { buildTiltModel, directionSourceOf } from '../utils/tiltModel.js'

export const PREVIEW_DEBOUNCE_MS = 400

// Keeps formState.profilePreview in step with the Advanced tilt-model inputs:
// a debounced POST /api/profile-preview whenever the azimuth, gradient, family,
// parameters, hinge, resolved origin or DEM bounds change -- and only while the
// tilt section's own inputs pass readiness (no request fires for e.g. a
// malformed rate).
//
// Mounted once in ProcessingPage rather than inside the tilt section's body, so
// the result exists even while that section is collapsed and is still there for
// the results screen's hinge summary. Stale responses are dropped with a
// request counter, the same pattern as the coordinate checks.
export function useProfilePreview() {
  const { formState, updateForm } = useProcessing()
  const requestId = useRef(0)
  const lastData = useRef(null)

  // The single-azimuth curve only: the vectors source has its own preview
  // (useUpliftPreview).
  const tiltReady =
    formState.mode === 'advanced' &&
    directionSourceOf(formState.advanced) === 'azimuth' &&
    getReadiness(formState).missing.every((m) => m.section !== 'tilt') &&
    Number.isFinite(Number(formState.tiltAzimuth)) &&
    Number.isFinite(Number(formState.tiltFactor))

  // One string key stands in for every input, so the effect re-runs exactly
  // when one of them changes (and not when its own result lands in formState).
  const body = tiltReady
    ? {
        tilt_azimuth: Number(formState.tiltAzimuth),
        tilt_factor: Number(formState.tiltFactor),
        tilt_model: buildTiltModel(formState.advanced),
        origin: formState.resolvedOrigin || null,
        bounds_wgs84: formState.boundsWgs84 || null
      }
    : null
  const key = body ? JSON.stringify(body) : null
  const hasResult = formState.profilePreview !== null

  useEffect(() => {
    const id = ++requestId.current // also invalidates any in-flight request
    if (key === null) {
      lastData.current = null
      if (hasResult) updateForm({ profilePreview: null })
      return undefined
    }
    const timer = setTimeout(async () => {
      updateForm({ profilePreview: { status: 'loading', data: lastData.current, error: null } })
      try {
        const data = await profilePreview(JSON.parse(key))
        if (id !== requestId.current) return // newer inputs were requested
        lastData.current = data
        updateForm({ profilePreview: { status: 'ready', data, error: null } })
      } catch (err) {
        if (id !== requestId.current) return
        lastData.current = null
        updateForm({ profilePreview: { status: 'error', data: null, error: err.message } })
      }
    }, PREVIEW_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // updateForm/hasResult are deliberately not dependencies: `key` alone
    // decides when a new request is due.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}
