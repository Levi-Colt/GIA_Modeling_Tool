import { useProcessing } from '../../context/ProcessingContext.jsx'

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

  return (
    <section id="step-coordinates" className="border-t border-gray-100 pt-3">
      <p className="mb-2 text-xs font-medium text-blue-600">3 · Coordinates</p>
      <input
        type="text"
        placeholder={config.placeholder}
        value={formState.originValue}
        onChange={(e) => updateForm({ originValue: e.target.value })}
        className="w-full"
      />
      {config.showEpsg && (
        <input
          type="text"
          placeholder="EPSG:32612"
          value={formState.originEpsg}
          onChange={(e) => updateForm({ originEpsg: e.target.value })}
          className="mt-2 w-full"
        />
      )}
    </section>
  )
}
