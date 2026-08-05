import { useProcessing } from '../../context/ProcessingContext.jsx'
import { originElevation, resolvePoint } from '../../api/client.js'

const MODE_CONFIG = {
  match_raster: { placeholder: '"x,y" in the raster\'s native CRS', showEpsg: false },
  decimal_degrees: { placeholder: '45.25N,110.55W', showEpsg: false },
  epsg: { placeholder: '"x,y" in the target CRS\'s units', showEpsg: true }
}

export function CoordinateModeStep() {
  const { formState, updateForm } = useProcessing()
  return (
    <section id="step-mode" className="border-t border-gray-100 pt-3">
      <p className="mb-2 text-xs text-gray-400">2 · Coordinate mode</p>
      <select value={formState.originMode} onChange={(e) => updateForm({ originMode: e.target.value })}>
        <option value="decimal_degrees">Decimal degrees</option>
        <option value="match_raster">Match raster</option>
        <option value="epsg">EPSG code</option>
      </select>
    </section>
  )
}

export function CoordinatesStep() {
  const { formState, updateForm } = useProcessing()
  const config = MODE_CONFIG[formState.originMode]

  // Preview the DEM's elevation at the resolved origin once the file is
  // known-good and the coordinate fields are complete enough to resolve —
  // fires on blur (mirrors UploadStep's path-input pattern), not on every
  // keystroke, since it's a real backend round-trip including reprojection.
  // /api/process re-derives this independently either way; this is UX only.
  async function checkElevation() {
    const originValue = formState.originValue.trim()
    if (formState.preflightStatus !== 'valid' || !originValue) return
    if (formState.originMode === 'epsg' && !formState.originEpsg.trim()) return

    updateForm({ elevationCheckStatus: 'checking', elevationCheckValue: null })
    try {
      const result = await originElevation(
        formState.demFile,
        formState.demPath,
        formState.originMode,
        originValue,
        formState.originEpsg
      )
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
      // Preview call failed -- fall back to a plain editable field, same as
      // if the check had never run.
      updateForm({ elevationCheckStatus: 'idle', elevationCheckValue: null })
    }
  }

  // Resolves the origin to (lon, lat) for the map's input preview (origin
  // marker + azimuth line) -- same blur trigger as checkElevation, since
  // both are cheap-ish backend round-trips that shouldn't fire on every
  // keystroke. Purely a preview: /api/process re-derives the real origin
  // independently either way.
  async function checkResolvedOrigin() {
    const originValue = formState.originValue.trim()
    if (!originValue) return
    if (formState.originMode === 'epsg' && !formState.originEpsg.trim()) return
    if (formState.originMode === 'match_raster' && !formState.demCrs) return

    updateForm({ resolveOriginStatus: 'checking' })
    try {
      const { lon, lat } = await resolvePoint(
        formState.originMode,
        originValue,
        formState.originEpsg,
        formState.demCrs
      )
      updateForm({ resolveOriginStatus: 'resolved', resolvedOrigin: [lon, lat] })
    } catch {
      updateForm({ resolveOriginStatus: 'error', resolvedOrigin: null })
    }
  }

  function handleBlur() {
    checkElevation()
    checkResolvedOrigin()
  }

  return (
    <section id="step-coordinates" className="border-t border-gray-100 pt-3">
      <p className="mb-2 text-xs font-medium text-blue-600">3 · Coordinates</p>
      <input
        type="text"
        placeholder={config.placeholder}
        value={formState.originValue}
        onChange={(e) => updateForm({ originValue: e.target.value })}
        onBlur={handleBlur}
        className="w-full"
      />
      {config.showEpsg && (
        <input
          type="text"
          placeholder="EPSG:32612"
          value={formState.originEpsg}
          onChange={(e) => updateForm({ originEpsg: e.target.value })}
          onBlur={handleBlur}
          className="mt-2 w-full"
        />
      )}
    </section>
  )
}
