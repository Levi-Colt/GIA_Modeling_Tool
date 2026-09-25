import { describe, it, expect } from 'vitest'
import { niceTicks } from './ticks.js'

describe('niceTicks', () => {
  it('gives round values inside the range', () => {
    expect(niceTicks(0, 100)).toEqual([0, 20, 40, 60, 80, 100])
    expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10])
  })

  it('handles negative-to-positive ranges, including a 0 tick', () => {
    expect(niceTicks(-54, 180)).toEqual([-50, 0, 50, 100, 150])
    expect(niceTicks(-20, 310, 4)).toEqual([0, 100, 200, 300])
    expect(niceTicks(-100, 100)).toEqual([-100, -50, 0, 50, 100])
  })

  it('handles an entirely negative range', () => {
    expect(niceTicks(-310, -20, 4)).toEqual([-300, -200, -100])
  })

  it('handles small fractional ranges without float noise', () => {
    expect(niceTicks(0, 0.3, 3)).toEqual([0, 0.1, 0.2, 0.3])
    expect(niceTicks(-0.02, 0.05, 5)).toEqual([-0.02, 0, 0.02, 0.04])
  })

  it('never returns -0', () => {
    expect(niceTicks(-1, 1).some((t) => Object.is(t, -0))).toBe(false)
  })

  it('stays within [min, max] and returns 3-7 ticks for typical ranges', () => {
    for (const [lo, hi] of [[-54, 180], [-3.7, 12.2], [0, 1], [-1e4, 4e4], [12.5, 13.5]]) {
      const ticks = niceTicks(lo, hi, 5)
      expect(ticks.length).toBeGreaterThanOrEqual(3)
      expect(ticks.length).toBeLessThanOrEqual(7)
      expect(Math.min(...ticks)).toBeGreaterThanOrEqual(lo)
      expect(Math.max(...ticks)).toBeLessThanOrEqual(hi)
    }
  })

  it('degenerate input', () => {
    expect(niceTicks(5, 5)).toEqual([5])
    expect(niceTicks(NaN, 1)).toEqual([])
    expect(niceTicks(10, 0)).toEqual(niceTicks(0, 10))
  })
})
