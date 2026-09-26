import { useEffect, useRef } from 'react'
import { useProcessing } from '../context/ProcessingContext.jsx'
import { fitUpliftSurface } from '../api/client.js'
import { buildFitBody } from '../utils/shorePoints.js'
import { usingPoints } from '../utils/tiltModel.js'

export const SURFACE_FIT_DEBOUNCE_MS = 500

// The POST /api/fit-uplift-surface request for the current form, or null while it
// can't be asked (not shore-points mode, the points aren't runnable, or the origin
// or DEM bounds are unknown). Shared by the hook and by whoever needs to know
// whether formState.surfaceFit answers the *current* inputs (compare `key`s).
export function surfaceFitBody(formState) {
  if (!usingPoints(formState)) return null
  return buildFitBody(formState.advanced, formState.resolvedOrigin, formState.boundsWgs84)
}

export const surfaceFitKey = (formState) => {
  const body = surfaceFitBody(formState)
  return body ? JSON.stringify(body) : null
}

// Keeps formState.surfaceFit -- the order comparison, residuals, isobases and hull
// for the shore-points direction source -- in step with the points, the order,
// the two options, the resolved origin and the DEM bounds: a debounced request
// whenever any changes, only while the points are runnable and the origin and
// bounds are known. Cleared when the source is not 'points', so a stale surface
// never lingers. Stale responses are dropped with a request counter, and each
// stored result carries the `key` of the request it answers. Mounted once in
// ProcessingPage, like the other preview hooks.
export function useSurfaceFit() {
  const { formState, updateForm } = useProcessing()
  const requestId = useRef(0)
  const lastData = useRef(null)

  const key = surfaceFitKey(formState)
  const hasResult = formState.surfaceFit !== null

  useEffect(() => {
    const id = ++requestId.current // also invalidates any in-flight request
    if (key === null) {
      lastData.current = null
      if (hasResult) updateForm({ surfaceFit: null })
      return undefined
    }
    const timer = setTimeout(async () => {
      updateForm({ surfaceFit: { status: 'loading', data: lastData.current, error: null, key: null } })
      try {
        const data = await fitUpliftSurface(JSON.parse(key))
        if (id !== requestId.current) return // newer inputs were requested
        lastData.current = data
        updateForm({ surfaceFit: { status: 'ready', data, error: null, key } })
      } catch (err) {
        if (id !== requestId.current) return
        lastData.current = null
        updateForm({ surfaceFit: { status: 'error', data: null, error: err.message, key: null } })
      }
    }, SURFACE_FIT_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // updateForm/hasResult are deliberately not dependencies: `key` alone
    // decides when a new request is due.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}
