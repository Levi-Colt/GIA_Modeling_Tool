import { useProcessing } from '../../context/ProcessingContext.jsx'

// Target elevation is DEM-authoritative server-side (see
// TARGET_ELEVATION_AND_GPKG_TASKS.md): when the origin lands on valid DEM
// data, /api/process silently overrides whatever's entered here regardless.
// This just previews that outcome so it doesn't read as a bug when the
// field goes disabled, or as a silent no-op when a typed value gets
// discarded server-side.
function TargetElevationField() {
  const { formState, updateForm } = useProcessing()
  const { elevationCheckStatus, elevationCheckValue, targetElevation } = formState

  if (elevationCheckStatus === 'checking') {
    return (
      <div>
        <input type="number" placeholder="Target elev. (m)" value={targetElevation} disabled className="w-full" />
        <p className="mt-1 text-xs text-gray-500">Checking DEM elevation at origin...</p>
      </div>
    )
  }

  if (elevationCheckStatus === 'dem') {
    return (
      <div>
        <input type="number" value={elevationCheckValue} disabled className="w-full" />
        <p className="mt-1 text-xs text-gray-500">{elevationCheckValue} m — from DEM at origin</p>
      </div>
    )
  }

  if (elevationCheckStatus === 'outside_bounds' || elevationCheckStatus === 'nodata') {
    const note =
      elevationCheckStatus === 'outside_bounds'
        ? 'Origin falls outside the DEM — enter a target elevation manually.'
        : 'No elevation data at the origin cell — enter a target elevation manually.'
    return (
      <div>
        <p className="mb-1 text-xs text-gray-500">{note}</p>
        <input
          type="number"
          placeholder="Target elev. (m)"
          value={targetElevation}
          onChange={(e) => updateForm({ targetElevation: e.target.value })}
          className="w-full"
        />
      </div>
    )
  }

  return (
    <input
      type="number"
      placeholder="Target elev. (m)"
      value={targetElevation}
      onChange={(e) => updateForm({ targetElevation: e.target.value })}
      className="w-full"
    />
  )
}

export function TiltStep() {
  const { formState, updateForm } = useProcessing()
  return (
    <section id="step-tilt" className="border-t border-gray-100 pt-3">
      <p className="mb-2 text-xs text-gray-400">4 · Tilt parameters</p>
      <div className="grid grid-cols-3 gap-2">
        <input
          type="number"
          placeholder="Azimuth (deg)"
          value={formState.tiltAzimuth}
          onChange={(e) => updateForm({ tiltAzimuth: e.target.value })}
        />
        <input
          type="number"
          placeholder="Tilt (m/km)"
          value={formState.tiltFactor}
          onChange={(e) => updateForm({ tiltFactor: e.target.value })}
        />
        <TargetElevationField />
      </div>
    </section>
  )
}

export function ProductsStep() {
  const { formState, updateForm } = useProcessing()
  return (
    <section id="step-products" className="border-t border-gray-100 pt-3">
      <p className="mb-2 text-xs text-gray-400">5 · Return products</p>
      <label className="flex items-center gap-2 text-sm text-gray-600">
        <input
          type="checkbox"
          checked={formState.includeDem}
          onChange={(e) => updateForm({ includeDem: e.target.checked })}
        />
        Include tilted DEM raster in output
      </label>
    </section>
  )
}
