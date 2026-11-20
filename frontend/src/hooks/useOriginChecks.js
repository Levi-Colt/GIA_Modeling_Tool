import { useEffect } from 'react'
import { useProcessing } from '../context/ProcessingContext.jsx'
import { originElevation, resolvePoint } from '../api/client.js'

// Which DEM an elevation check is about: the file object or typed path of a DEM
// that passed preflight, or null while there is none.
const demKeyOf = (s) => (s.preflightStatus === 'valid' ? s.demFile ?? s.demPath : null)

// The two blur-triggered origin lookups, shared by the typed coordinate field and
// the map's "pick origin" click. Both are previews only: /api/process re-derives
// the real origin and (DEM-authoritative) target elevation independently.
export function useOriginChecks() {
  const { formState, updateForm } = useProcessing()

  // Preview the DEM's elevation at the origin once the file is known-good.
  // Fires on blur / pick, not per keystroke: it is a real backend round-trip
  // including reprojection. Without a valid DEM it does nothing; the check then
  // runs when the DEM's preflight succeeds (useRecheckOriginOnDem), so the order
  // the two fields are filled in doesn't matter.
  async function checkElevation(value = formState.originValue) {
    const originValue = value.trim()
    if (formState.preflightStatus !== 'valid' || !originValue) return
    const demKey = demKeyOf(formState)
    // An answer only applies while the field and the DEM are still the ones it
    // was asked about; an edit or a new DEM in the meantime makes it stale.
    const current = (prev) => prev.originValue.trim() === originValue && demKeyOf(prev) === demKey
    const apply = (patch) => updateForm((prev) => (current(prev) ? patch : null))
    updateForm({ elevationCheckStatus: 'checking', elevationCheckValue: null })
    try {
      const result = await originElevation(formState.demFile, formState.demPath, originValue)
      if (result.within_bounds && result.elevation !== null) {
        apply({
          elevationCheckStatus: 'dem',
          elevationCheckValue: result.elevation,
          targetElevation: result.elevation
        })
      } else if (result.reason === 'nodata') {
        apply({ elevationCheckStatus: 'nodata', elevationCheckValue: null })
      } else {
        apply({ elevationCheckStatus: 'outside_bounds', elevationCheckValue: null })
      }
    } catch {
      // Preview failed -- an editable field the user fills in by hand (the run
      // still takes the DEM's elevation server-side if the origin is on it).
      apply({ elevationCheckStatus: 'error', elevationCheckValue: null })
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

// Runs the origin checks again whenever a DEM passes preflight (a first DEM or a
// replacement): an origin entered before the DEM was ready had its elevation
// check skipped, and one checked against a previous DEM is stale. Skipped while
// the origin field has focus -- its own blur runs both checks.
export function useRecheckOriginOnDem() {
  const { formState } = useProcessing()
  const { checkElevation, checkResolvedOrigin } = useOriginChecks()
  const demKey = demKeyOf(formState)
  useEffect(() => {
    if (demKey === null || !formState.originValue.trim()) return
    if (typeof document !== 'undefined' && document.activeElement?.id === 'origin-input') return
    checkElevation()
    if (formState.resolveOriginStatus === 'idle') checkResolvedOrigin()
    // Only a change of DEM triggers this; the field's own blur handles the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demKey])
}
