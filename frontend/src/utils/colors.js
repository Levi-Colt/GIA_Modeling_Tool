// Diverging color scale for shore-point residuals (documentation/
// SHORE_POINT_SURFACE_SPEC.md F4): blue for points below the fitted surface
// (negative residual), orange for points above it, a light neutral at zero. Blue
// and orange rather than red and green: colorblind-safer, and the two ends also
// differ in lightness, so the sign survives in grayscale.
export const RESIDUAL_NEGATIVE = '#2166ac'
export const RESIDUAL_ZERO = '#f7f7f7'
export const RESIDUAL_POSITIVE = '#e08214'

// For the map legend's gradient bar (negative end on the left).
export const RESIDUAL_GRADIENT = `linear-gradient(to right, ${RESIDUAL_NEGATIVE}, ${RESIDUAL_ZERO}, ${RESIDUAL_POSITIVE})`

// A shore point with no residual yet (the fit hasn't come back): neutral gray.
export const RESIDUAL_UNKNOWN = '#9ca3af'

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`
}

function mix(from, to, t) {
  const a = hexToRgb(from)
  const b = hexToRgb(to)
  return rgbToHex(a.map((c, i) => c + (b[i] - c) * t))
}

// The largest |residual| among the finite values: the scale is symmetric about
// zero, so the two ends mean the same magnitude. 0 when there are none.
export function residualExtent(residuals) {
  let max = 0
  for (const r of residuals ?? []) if (Number.isFinite(r) && Math.abs(r) > max) max = Math.abs(r)
  return max
}

// Hex color for a residual on the scale [-maxAbs, +maxAbs] (clamped): exactly
// RESIDUAL_NEGATIVE at -maxAbs, RESIDUAL_ZERO at 0, RESIDUAL_POSITIVE at +maxAbs.
// A missing residual, or a scale with no extent, gives RESIDUAL_UNKNOWN / the neutral.
export function residualColor(residual, maxAbs) {
  if (!Number.isFinite(residual)) return RESIDUAL_UNKNOWN
  if (!(maxAbs > 0)) return RESIDUAL_ZERO
  const t = Math.max(-1, Math.min(1, residual / maxAbs))
  return t < 0 ? mix(RESIDUAL_ZERO, RESIDUAL_NEGATIVE, -t) : mix(RESIDUAL_ZERO, RESIDUAL_POSITIVE, t)
}
