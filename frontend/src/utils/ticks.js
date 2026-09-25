// "Nice" axis ticks for the profile chart: round values (1, 2, 2.5, 5 x 10^k)
// inside [min, max], roughly `count` of them (typically 4-5 for count = 5).
export function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return []
  if (min > max) [min, max] = [max, min]
  if (min === max) return [min]

  const rawStep = (max - min) / count
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rawStep)

  const first = Math.ceil(min / step - 1e-9)
  const last = Math.floor(max / step + 1e-9)
  const ticks = []
  for (let i = first; i <= last; i++) {
    // toFixed(10) drops float noise (0.1 * 3 -> 0.30000000000000004).
    const tick = Number((i * step).toFixed(10))
    ticks.push(tick === 0 ? 0 : tick) // no -0
  }
  return ticks
}
