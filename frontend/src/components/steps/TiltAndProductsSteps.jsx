import { useProcessing } from '../../context/ProcessingContext.jsx'

// Target elevation is DEM-authoritative server-side (see
// TARGET_ELEVATION_AND_GPKG_TASKS.md): when the origin lands on valid DEM
// data, /api/process silently overrides whatever's entered here regardless.
// This just previews that outcome so it doesn't read as a bug when the
// field goes disabled, or as a silent no-op when a typed value gets
// discarded server-side.
export function TargetElevationField() {
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

// Azimuth and tilt-factor inputs, shared by both modes. In Advanced these are
// labelled "Single azimuth" / "Gradient at origin (m/km)" -- the same two
// top-level formState keys either way, so a value typed in one mode shows up
// in the other.
export function TiltInputs({ azimuthLabel = 'Azimuth (deg)', factorLabel = 'Tilt (m/km)' }) {
  const { formState, updateForm } = useProcessing()
  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="block text-xs text-gray-500">
        {azimuthLabel}
        <input
          type="number"
          placeholder="Azimuth (deg)"
          value={formState.tiltAzimuth}
          onChange={(e) => updateForm({ tiltAzimuth: e.target.value })}
          className="mt-1 w-full"
        />
      </label>
      <label className="block text-xs text-gray-500">
        {factorLabel}
        <input
          type="number"
          placeholder="Tilt (m/km)"
          value={formState.tiltFactor}
          onChange={(e) => updateForm({ tiltFactor: e.target.value })}
          className="mt-1 w-full"
        />
      </label>
    </div>
  )
}

// Output-section body (selection radius + include-DEM), shared by both modes.
export function ProductsStep() {
  const { formState, updateForm } = useProcessing()
  return (
    <div>
      <label className="block text-sm text-gray-600">
        Selection radius (km, optional)
        <input
          type="number"
          min="0"
          step="any"
          placeholder="No limit"
          value={formState.selectionRadiusKm}
          onChange={(e) => updateForm({ selectionRadiusKm: e.target.value })}
          className="mt-1 w-full"
        />
      </label>
      <p className="mb-2 text-xs text-gray-500">
        Only contours that come within this distance of the origin are kept (whole, not clipped).
      </p>
      <label className="flex items-center gap-2 text-sm text-gray-600">
        <input
          type="checkbox"
          checked={formState.includeDem}
          onChange={(e) => updateForm({ includeDem: e.target.checked })}
        />
        Include tilted DEM raster in output
      </label>
    </div>
  )
}
