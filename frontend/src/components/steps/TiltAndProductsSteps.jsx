import { useProcessing } from '../../context/ProcessingContext.jsx'
import Field, { statusBorder, valueStatus } from '../shared/Field.jsx'
import { parseFiniteNumber } from '../../utils/numbers.js'
import { parseSelectionRadiusKm } from '../../utils/readiness.js'

// Target elevation is DEM-authoritative server-side (see
// TARGET_ELEVATION_AND_GPKG_TASKS.md): when the origin lands on valid DEM
// data, /api/process silently overrides whatever's entered here regardless.
// This just previews that outcome so it doesn't read as a bug when the
// field goes disabled, or as a silent no-op when a typed value gets
// discarded server-side.
export function TargetElevationField() {
  const { formState, updateForm } = useProcessing()
  const { elevationCheckStatus, elevationCheckValue, targetElevation } = formState

  // The label is always shown, including in the disabled/derived states.
  let status = valueStatus(targetElevation, { required: true })
  let message = null
  let input
  if (elevationCheckStatus === 'checking') {
    status = 'checking'
    message = 'Checking DEM elevation at origin...'
    input = <input type="number" placeholder="Target elev. (m)" value={targetElevation} disabled className="w-full" />
  } else if (elevationCheckStatus === 'dem') {
    status = 'valid'
    message = `${elevationCheckValue} m — from DEM at origin`
    input = <input type="number" value={elevationCheckValue} disabled className={`w-full ${statusBorder(status)}`} />
  } else {
    if (elevationCheckStatus === 'outside_bounds') {
      message = 'Origin falls outside the DEM — enter a target elevation manually.'
    }
    if (elevationCheckStatus === 'nodata') {
      message = 'No elevation data at the origin cell — enter a target elevation manually.'
    }
    input = (
      <input
        type="number"
        placeholder="Target elev. (m)"
        value={targetElevation}
        onChange={(e) => updateForm({ targetElevation: e.target.value })}
        className={`w-full ${statusBorder(status)}`}
      />
    )
  }

  return (
    <Field
      label="Target elevation (m)"
      status={status}
      message={message}
      help="Strandlines are extracted at the spillway's present elevation, assuming the sill hasn't changed since the shoreline formed."
    >
      {input}
    </Field>
  )
}

// Azimuth and tilt-factor inputs, shared by both modes. In Advanced these are
// labelled "Single azimuth" / "Gradient at spillway (m/km)" -- the same two
// top-level formState keys either way, so a value typed in one mode shows up
// in the other. `showAzimuth={false}` (Advanced, multiple directions) shows
// only the gradient: there is no single azimuth then, but the value is kept.
// `factorRequired={false}` (every vector has its own tilt) drops the blue outline.
export function TiltInputs({
  azimuthLabel = 'Azimuth (deg)',
  factorLabel = 'Tilt (m/km)',
  factorHelp = null,
  showAzimuth = true,
  factorRequired = true
}) {
  const { formState, updateForm } = useProcessing()
  const azimuthStatus = valueStatus(formState.tiltAzimuth, {
    required: true,
    ok: parseFiniteNumber(formState.tiltAzimuth) !== null
  })
  const factorStatus = valueStatus(formState.tiltFactor, {
    required: factorRequired,
    ok: parseFiniteNumber(formState.tiltFactor) !== null
  })
  return (
    <div>
      <div className={showAzimuth ? 'grid grid-cols-2 gap-2' : undefined}>
        {showAzimuth && (
          <Field label={azimuthLabel} status={azimuthStatus}>
            <input
              type="number"
              placeholder="Azimuth (deg)"
              value={formState.tiltAzimuth}
              onChange={(e) => updateForm({ tiltAzimuth: e.target.value })}
              className={`w-full ${statusBorder(azimuthStatus)}`}
            />
          </Field>
        )}
        <Field label={factorLabel} status={factorStatus}>
          <input
            type="number"
            placeholder="Tilt (m/km)"
            value={formState.tiltFactor}
            onChange={(e) => updateForm({ tiltFactor: e.target.value })}
            className={`w-full ${statusBorder(factorStatus)}`}
          />
        </Field>
      </div>
      {factorHelp && <p className="mt-1 text-xs text-gray-500">{factorHelp}</p>}
    </div>
  )
}

// Output-section body (selection radius + include-DEM), shared by both modes.
export function ProductsStep() {
  const { formState, updateForm } = useProcessing()
  const radius = formState.selectionRadiusKm
  const radiusStatus = valueStatus(radius, { ok: parseSelectionRadiusKm(radius) !== null })
  return (
    <div className="space-y-3">
      <Field
        label="Selection radius (km, optional)"
        status={radiusStatus}
        help="Only contours that come within this distance of the origin are kept (whole, not clipped)."
      >
        <input
          type="number"
          min="0"
          step="any"
          placeholder="No limit"
          value={radius}
          onChange={(e) => updateForm({ selectionRadiusKm: e.target.value })}
          className={`w-full ${statusBorder(radiusStatus)}`}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm text-gray-700">
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
