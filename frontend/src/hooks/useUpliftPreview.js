import { useEffect, useRef } from 'react'
import { useProcessing } from '../context/ProcessingContext.jsx'
import { upliftPreview } from '../api/client.js'
import { getReadiness } from '../utils/readiness.js'
import { buildTiltModel, usingVectors } from '../utils/tiltModel.js'
import { anyGlobal, normalizeVectors } from '../utils/vectors.js'

export const UPLIFT_PREVIEW_DEBOUNCE_MS = 500

// Keeps formState.upliftPreview -- the map's isobases and each vector's fit --
// in step with the vectors direction source: a debounced POST
// /api/uplift-preview whenever the vectors, the global profile, the hinge, the
// gradient at the spillway, the resolved origin or the DEM bounds change, and
// only while the tilt section is runnable and the origin and bounds are known
// (the endpoint needs both). Map drags commit to state on drag end only, so this
// is not spammed mid-drag. Cleared when the source is not 'vectors', so stale
// isobases never linger. Mounted once in ProcessingPage, like useProfilePreview;
// stale responses are dropped with a request counter.
export function useUpliftPreview() {
  const { formState, updateForm } = useProcessing()
  const requestId = useRef(0)
  const lastData = useRef(null)

  const ready =
    usingVectors(formState) &&
    getReadiness(formState).missing.every((m) => m.section !== 'tilt') &&
    !!formState.resolvedOrigin &&
    !!formState.boundsWgs84

  let body = null
  if (ready) {
    const global = anyGlobal(normalizeVectors(formState.advanced.vectors))
    body = {
      // Only while some vector uses the global profile (see buildProcessPayload).
      ...(global ? { tilt_factor: Number(formState.tiltFactor) } : {}),
      tilt_model: buildTiltModel(formState.advanced),
      origin: formState.resolvedOrigin,
      bounds_wgs84: formState.boundsWgs84
    }
  }
  const key = body ? JSON.stringify(body) : null
  const hasResult = formState.upliftPreview !== null

  useEffect(() => {
    const id = ++requestId.current // also invalidates any in-flight request
    if (key === null) {
      lastData.current = null
      if (hasResult) updateForm({ upliftPreview: null })
      return undefined
    }
    const timer = setTimeout(async () => {
      updateForm({ upliftPreview: { status: 'loading', data: lastData.current, error: null } })
      try {
        const data = await upliftPreview(JSON.parse(key))
        if (id !== requestId.current) return // newer inputs were requested
        lastData.current = data
        updateForm({ upliftPreview: { status: 'ready', data, error: null } })
      } catch (err) {
        if (id !== requestId.current) return
        lastData.current = null
        updateForm({ upliftPreview: { status: 'error', data: null, error: err.message } })
      }
    }, UPLIFT_PREVIEW_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // updateForm/hasResult are deliberately not dependencies: `key` alone
    // decides when a new request is due.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}
