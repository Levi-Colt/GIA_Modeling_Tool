import { describe, it, expect } from 'vitest'
import {
  RESIDUAL_NEGATIVE,
  RESIDUAL_POSITIVE,
  RESIDUAL_UNKNOWN,
  RESIDUAL_ZERO,
  residualColor,
  residualExtent
} from './colors.js'

describe('residualColor', () => {
  it('maps the endpoints and zero exactly', () => {
    expect(residualColor(-8, 8)).toBe(RESIDUAL_NEGATIVE)
    expect(residualColor(8, 8)).toBe(RESIDUAL_POSITIVE)
    expect(residualColor(0, 8)).toBe(RESIDUAL_ZERO)
  })

  it('clamps beyond the extent', () => {
    expect(residualColor(-50, 8)).toBe(RESIDUAL_NEGATIVE)
    expect(residualColor(50, 8)).toBe(RESIDUAL_POSITIVE)
  })

  it('is symmetric: equal magnitudes sit equally far from the neutral', () => {
    const channel = (hex, i) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16)
    const neutral = [0, 1, 2].map((i) => channel(RESIDUAL_ZERO, i))
    const distance = (hex) => Math.hypot(...[0, 1, 2].map((i) => channel(hex, i) - neutral[i]))
    // Each end is its own hue, so compare each against its own endpoint's distance.
    const ratio = (hex, end) => distance(hex) / distance(end)
    expect(ratio(residualColor(-2, 8), RESIDUAL_NEGATIVE)).toBeCloseTo(0.25, 1)
    expect(ratio(residualColor(2, 8), RESIDUAL_POSITIVE)).toBeCloseTo(0.25, 1)
  })

  it('deepens monotonically away from the neutral', () => {
    const channel = (hex, i) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16)
    // Toward blue the red channel falls; toward orange the blue channel falls.
    expect(channel(residualColor(-2, 8), 0)).toBeGreaterThan(channel(residualColor(-6, 8), 0))
    expect(channel(residualColor(2, 8), 2)).toBeGreaterThan(channel(residualColor(6, 8), 2))
  })

  it('the two ends differ in lightness (the sign survives grayscale)', () => {
    const luma = (hex) => {
      const [r, g, b] = [0, 1, 2].map((i) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16))
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    expect(Math.abs(luma(RESIDUAL_NEGATIVE) - luma(RESIDUAL_POSITIVE))).toBeGreaterThan(40)
  })

  it('handles a missing residual and a scale with no extent', () => {
    expect(residualColor(null, 8)).toBe(RESIDUAL_UNKNOWN)
    expect(residualColor(NaN, 8)).toBe(RESIDUAL_UNKNOWN)
    expect(residualColor(3, 0)).toBe(RESIDUAL_ZERO)
  })
})

describe('residualExtent', () => {
  it('is the largest absolute residual, ignoring non-finite values', () => {
    expect(residualExtent([1, -4.5, 2, NaN, null])).toBe(4.5)
    expect(residualExtent([])).toBe(0)
    expect(residualExtent(null)).toBe(0)
  })
})
