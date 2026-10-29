import { useProcessing } from '../context/ProcessingContext.jsx'
import { originElevation, resolvePoint } from '../api/client.js'

// The two blur-triggered origin lookups, shared by the typed coordinate field and
// the map's "pick origin" click. Both are previews only: /api/process re-derives
// the real origin and (DEM-authoritative) target elevation independently.
export function useOriginChecks() {
  const { formState, updateForm } = useProcessing()

  // Preview the DEM's elevation at the origin once the file is known-good.
  // Fires on blur / pick, not per keystroke: it is a real backend round-trip
  // including reprojection.
  async function checkElevation(value = formState.originValue) {
    const originValue = value.trim()
    if (formState.preflightStatus !== 'valid' || !originValue) return
    updateForm({ elevationCheckStatus: 'checking', elevationCheckValue: null })
    try {
      const result = await originElevation(formState.demFile, formState.demPath, originValue)
      if (result.within_bounds && result.elevation !== null) {
        updateForm({
          elevationCheckStatus: 'dem',
          elevationCheckValue: result.elevation,
          targetElevation: result.elevation
        })
      } else if (result.reason === 'nodata') {
        updateForm({ elevationCheckStatus: 'nodata', elevationCheckValue: null })
      } else {
        updateForm({ elevationCheckStatus: 'outside_bounds', elevationCheckValue: null })
      }
    } catch {
      // Preview failed -- fall back to a plain editable field, as if never run.
      updateForm({ elevationCheckStatus: 'idle', elevationCheckValue: null })
    }
  }

  // Resolve the origin to (lon, lat) for the map's origin marker and azimuth line.
  async function checkResolvedOrigin(value = formState.originValue) {
    const originValue = value.trim()
    if (!originValue) return
    updateForm({ resolveOriginStatus: 'checking', resolveOriginMessage: '' })
    try {
      const { lon, lat } = await resolvePoint(originValue)
      updateForm({ resolveOriginStatus: 'resolved', resolvedOrigin: [lon, lat], resolveOriginMessage: '' })
    } catch (err) {
      updateForm({ resolveOriginStatus: 'error', resolvedOrigin: null, resolveOriginMessage: err.message })
    }
  }

  return { checkElevation, checkResolvedOrigin, checkOrigin: (value) => Promise.all([checkElevation(value), checkResolvedOrigin(value)]) }
}
