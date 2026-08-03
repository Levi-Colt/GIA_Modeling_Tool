import { useProcessing } from '../../context/ProcessingContext.jsx'

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
        <input
          type="number"
          placeholder="Target elev. (m)"
          value={formState.targetElevation}
          onChange={(e) => updateForm({ targetElevation: e.target.value })}
        />
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
