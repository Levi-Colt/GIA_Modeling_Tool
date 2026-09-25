import Banner from '../shared/Banner.jsx'
import { niceTicks } from '../../utils/ticks.js'
import { formatNumber, guardNote } from '../../utils/tiltModel.js'

// Uplift-vs-distance preview for the Advanced tilt model: a small hand-rolled
// SVG (no charting dependency). `preview` is formState.profilePreview:
// { status: 'loading' | 'ready' | 'error', data, error } | null, where `data`
// is /api/profile-preview's response. `secondGradient` ({ gradient, distanceKm },
// or null) marks the user's second-gradient point on the curve while that
// curvature form is active. The zero line is the spillway (the code calls it the
// origin).

const W = 440
const H = 160
const M = { left: 46, right: 12, top: 12, bottom: 30 }
const PLOT_W = W - M.left - M.right
const PLOT_H = H - M.top - M.bottom

// Uplift at distance x (km), linearly interpolated from the returned samples;
// null when x is outside the plotted range.
export function upliftAt({ d_km: d, uplift_m: u }, x) {
  for (let i = 0; i < d.length - 1; i++) {
    if (x >= d[i] && x <= d[i + 1]) {
      const t = d[i + 1] === d[i] ? 0 : (x - d[i]) / (d[i + 1] - d[i])
      return u[i] + t * (u[i + 1] - u[i])
    }
  }
  return null
}

// "Uplift versus distance from the spillway: from −20 m at −54 km (hinge) to 310 m at 180 km"
export function describeCurve({ d_km: d, uplift_m: u, hinge_km: hinge }, secondGradient = null) {
  const last = d.length - 1
  const hingeInRange = hinge !== null && hinge !== undefined && hinge > d[0] && hinge <= d[last]
  // Behind the hinge uplift is flat, so the curve effectively starts there.
  const startD = hingeInRange ? hinge : d[0]
  const startU = u[0]
  const marked =
    secondGradient && upliftAt({ d_km: d, uplift_m: u }, secondGradient.distanceKm) !== null
      ? `; second gradient of ${formatNumber(secondGradient.gradient)} m/km marked at ${formatNumber(secondGradient.distanceKm)} km`
      : ''
  return (
    `Uplift versus distance from the spillway: from ${formatNumber(startU)} m at ${formatNumber(startD)} km` +
    `${hingeInRange ? ' (hinge)' : ''} to ${formatNumber(u[last])} m at ${formatNumber(d[last])} km${marked}`
  )
}

function Curve({ data, secondGradient }) {
  const { d_km: d, uplift_m: u, hinge_km: hinge } = data
  const last = d.length - 1
  const dMin = d[0]
  const dMax = d[last]

  let uMin = Math.min(...u)
  let uMax = Math.max(...u)
  if (uMin === uMax) {
    uMin -= 1
    uMax += 1
  }
  const pad = (uMax - uMin) * 0.06
  uMin -= pad
  uMax += pad

  const x = (v) => M.left + ((v - dMin) / (dMax - dMin || 1)) * PLOT_W
  const y = (v) => M.top + (1 - (v - uMin) / (uMax - uMin)) * PLOT_H
  const points = (pts) => pts.map(([dv, uv]) => `${x(dv).toFixed(1)},${y(uv).toFixed(1)}`).join(' ')

  const hasHinge = hinge !== null && hinge !== undefined
  const hingeVisible = hasHinge && hinge >= dMin && hinge <= dMax
  // Uplift is constant behind the hinge, so any clamped sample gives its value.
  const clamped = hasHinge ? d.map((dv, i) => [dv, u[i]]).filter(([dv]) => dv < hinge) : []
  const free = d.map((dv, i) => [dv, u[i]]).filter(([dv]) => !hasHinge || dv >= hinge)
  if (clamped.length && hingeVisible) {
    const flat = clamped[clamped.length - 1][1]
    // Join the two pieces at the hinge itself.
    clamped.push([hinge, flat])
    free.unshift([hinge, flat])
  }

  const xTicks = niceTicks(dMin, dMax, 5)
  const yTicks = niceTicks(uMin, uMax, 4)
  const originVisible = dMin <= 0 && dMax >= 0
  const markedU = secondGradient ? upliftAt(data, secondGradient.distanceKm) : null

  return (
    <svg
      role="img"
      aria-label={describeCurve(data, secondGradient)}
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      style={{ maxWidth: W }}
    >
      <rect x={M.left} y={M.top} width={PLOT_W} height={PLOT_H} fill="none" stroke="#d1d5db" />

      {yTicks.map((t) => (
        <g key={`y${t}`}>
          <line x1={M.left} x2={M.left + PLOT_W} y1={y(t)} y2={y(t)} stroke="#f3f4f6" />
          <text x={M.left - 5} y={y(t) + 3} textAnchor="end" fontSize="9" fill="#6b7280">
            {formatNumber(t, 4)}
          </text>
        </g>
      ))}
      {xTicks.map((t) => (
        <g key={`x${t}`}>
          <line x1={x(t)} x2={x(t)} y1={M.top + PLOT_H} y2={M.top + PLOT_H + 3} stroke="#9ca3af" />
          <text x={x(t)} y={M.top + PLOT_H + 13} textAnchor="middle" fontSize="9" fill="#6b7280">
            {formatNumber(t, 4)}
          </text>
        </g>
      ))}
      <text x={M.left + PLOT_W / 2} y={H - 4} textAnchor="middle" fontSize="9" fill="#6b7280">
        distance along azimuth (km)
      </text>
      <text
        transform={`translate(10 ${M.top + PLOT_H / 2}) rotate(-90)`}
        textAnchor="middle"
        fontSize="9"
        fill="#6b7280"
      >
        uplift (m)
      </text>

      {originVisible && (
        <g data-testid="origin-line">
          <line x1={x(0)} x2={x(0)} y1={M.top} y2={M.top + PLOT_H} stroke="#9ca3af" strokeDasharray="2 2" />
          <text x={x(0) + 3} y={M.top + 9} fontSize="9" fill="#6b7280">
            spillway
          </text>
        </g>
      )}

      {clamped.length > 1 && (
        <polyline
          data-testid="clamped-segment"
          points={points(clamped)}
          fill="none"
          stroke="#2563eb"
          strokeWidth="1.5"
          strokeDasharray="4 3"
        />
      )}
      {free.length > 1 && (
        <polyline data-testid="profile-line" points={points(free)} fill="none" stroke="#2563eb" strokeWidth="1.5" />
      )}

      {hingeVisible && (
        <circle
          data-testid="hinge-marker"
          cx={x(hinge)}
          cy={y(clamped.length ? clamped[clamped.length - 1][1] : u[d.findIndex((dv) => dv >= hinge)])}
          r="3.5"
          fill="#fff"
          stroke="#2563eb"
          strokeWidth="1.5"
        />
      )}
      {markedU !== null && (
        <g data-testid="second-gradient-marker">
          <title>{`Second gradient: ${formatNumber(secondGradient.gradient)} m/km at ${formatNumber(secondGradient.distanceKm)} km`}</title>
          <rect
            x={x(secondGradient.distanceKm) - 3.5}
            y={y(markedU) - 3.5}
            width="7"
            height="7"
            transform={`rotate(45 ${x(secondGradient.distanceKm)} ${y(markedU)})`}
            fill="#2563eb"
            stroke="#fff"
            strokeWidth="1"
          />
        </g>
      )}
    </svg>
  )
}

export default function ProfileChart({ preview, secondGradient = null }) {
  const data = preview?.data ?? null
  const warnings = data?.warnings ?? []

  return (
    <div className="space-y-2">
      <div className="text-xs text-gray-500">Uplift preview</div>
      {data ? (
        <div className={preview.status === 'loading' ? 'opacity-60' : undefined}>
          <Curve data={data} secondGradient={secondGradient} />
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-gray-300 px-3 py-6 text-center text-xs text-gray-500">
          {preview?.status === 'error'
            ? preview.error
            : preview?.status === 'loading'
              ? 'Updating preview...'
              : 'Fill in the tilt parameters to preview the profile.'}
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
