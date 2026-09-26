import Banner from '../shared/Banner.jsx'
import { formatNumber, guardNote } from '../../utils/tiltModel.js'

// The vectors-mode counterpart of the profile chart: a spatial model has no
// single 1D profile (it would mislead once directions vary), so the isobases go
// on the map and this shows the fit. `preview` is formState.upliftPreview:
// { status: 'loading' | 'ready' | 'error', data, error } | null.
export function describeFit(data) {
  if (!Number.isFinite(data.misfit_rms_deg)) {
    return 'No vector lies inside the fitted area, so no direction fit could be measured.'
  }
  const interval = Number.isFinite(data.interval_m) ? ` Isobases every ${formatNumber(data.interval_m)} m.` : ''
  return (
    `Direction fit: RMS ${data.misfit_rms_deg.toFixed(1)}°, max ${data.misfit_max_deg.toFixed(1)}° ` +
    `(vector ${data.worst_vector + 1}).${interval}`
  )
}

export default function VectorFitSummary({ preview }) {
  const data = preview?.data ?? null
  const warnings = data?.warnings ?? []
  return (
    <div className="space-y-2">
      <div className="text-xs text-gray-500">Uplift preview</div>
      {data ? (
        <p className={`text-xs text-gray-700 ${preview.status === 'loading' ? 'opacity-60' : ''}`}>{describeFit(data)}</p>
      ) : (
        <p className="rounded-md border border-dashed border-gray-300 px-3 py-4 text-center text-xs text-gray-500">
          {preview?.status === 'error'
            ? preview.error
            : preview?.status === 'loading'
              ? 'Updating preview...'
              : 'Complete the vectors, DEM and origin to see the fitted isobases on the map.'}
        </p>
      )}
      {data?.hinge_source === 'guard' && Number.isFinite(data.hinge_km) && (
        <Banner variant="info">{guardNote(data.hinge_km)}</Banner>
      )}
      {warnings.map((w) => (
        <Banner key={w} variant="warning">
          {w}
        </Banner>
      ))}
    </div>
  )
}
