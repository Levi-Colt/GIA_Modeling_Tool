import { describe, it, expect } from 'vitest'
import {
  CLICK_DRAG_PX,
  FALLBACK_ARROW_KM,
  arrowGeometry,
  arrowLengthKm,
  bearingDeg,
  distanceKm,
  haversineKm,
  isClick,
  pointAlong
} from './geometry.js'

describe('bearingDeg', () => {
  it('matches the cardinal directions, clockwise from north', () => {
    expect(bearingDeg([0, 0], [0, 1])).toBeCloseTo(0, 6)
    expect(bearingDeg([0, 0], [1, 0])).toBeCloseTo(90, 6)
    expect(bearingDeg([0, 0], [0, -1])).toBeCloseTo(180, 6)
    expect(bearingDeg([0, 0], [-1, 0])).toBeCloseTo(270, 6) // turf's -90, normalized
  })

  it('is always in [0, 360)', () => {
    for (const [dx, dy] of [[1, 1], [-1, 1], [-1, -1], [1, -1], [-0.001, 5]]) {
      const b = bearingDeg([10, 45], [10 + dx, 45 + dy])
      expect(b).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThan(360)
    }
    // atan2(sin(1°)cos(46°), cos(45°)sin(46°) - sin(45°)cos(46°)cos(1°)) = 34.67°
    expect(bearingDeg([10, 45], [11, 46])).toBeCloseTo(34.67, 1)
  })
})

describe('distanceKm', () => {
  it('one degree of latitude is about 111.2 km', () => {
    expect(Math.abs(distanceKm([0, 0], [0, 1]) - 111.19)).toBeLessThan(0.05)
  })

  it('one degree of longitude shrinks with latitude', () => {
    const atEquator = distanceKm([0, 0], [1, 0])
    const at60 = distanceKm([0, 60], [1, 60])
    expect(at60 / atEquator).toBeCloseTo(0.5, 2)
  })

  it('agrees with the haversine helper used for the azimuth line', () => {
    expect(distanceKm([-105, 40], [-104, 41])).toBeCloseTo(haversineKm([-105, 40], [-104, 41]), 0)
  })
})

describe('pointAlong / arrowGeometry', () => {
  it('pointAlong is the inverse of bearing + distance', () => {
    const origin = [-105, 45]
    const tip = pointAlong(origin, 30, 60)
    expect(distanceKm(origin, tip)).toBeCloseTo(30, 3)
    expect(bearingDeg(origin, tip)).toBeCloseTo(60, 1)
  })

  it('draws a shaft of the given length along the azimuth, with a triangular head at the tip', () => {
    const base = [-105, 45]
    const { shaft, head } = arrowGeometry(base, 90, 20)
    expect(shaft[0]).toEqual(base)
    expect(distanceKm(base, shaft[1])).toBeCloseTo(20, 3)
    expect(bearingDeg(base, shaft[1])).toBeCloseTo(90, 1)

    expect(head).toHaveLength(3)
    expect(head[0]).toEqual(shaft[1]) // the apex is the tip
    // The barbs sit back toward the base, either side of the shaft.
    for (const barb of head.slice(1)) {
      expect(distanceKm(head[0], barb)).toBeCloseTo(20 * 0.18, 2)
      expect(distanceKm(base, barb)).toBeLessThan(20)
    }
    expect(head[1][1]).not.toBeCloseTo(head[2][1], 5) // one north of the shaft, one south
  })
})

describe('arrowLengthKm', () => {
  const extent = [-106, 44, -105, 45]

  it('uses the range when there is one', () => {
    expect(arrowLengthKm(150, extent)).toBe(150)
  })

  it('otherwise 10% of the DEM diagonal', () => {
    const diagonal = haversineKm([-106, 44], [-105, 45])
    expect(arrowLengthKm(null, extent)).toBeCloseTo(0.1 * diagonal, 6)
    expect(arrowLengthKm(0, extent)).toBeCloseTo(0.1 * diagonal, 6) // a non-positive range is no range
  })

  it('falls back to a fixed length with no extent', () => {
    expect(arrowLengthKm(null, null)).toBe(FALLBACK_ARROW_KM)
  })
})

describe('isClick (a short drag counts as a click)', () => {
  it('is a click under the threshold, a drag at or beyond it', () => {
    expect(CLICK_DRAG_PX).toBe(8)
    expect(isClick({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(true)
    expect(isClick({ x: 10, y: 10 }, { x: 14, y: 16 })).toBe(true) // 7.2 px
    expect(isClick({ x: 10, y: 10 }, { x: 16, y: 16 })).toBe(false) // 8.5 px
    expect(isClick({ x: 0, y: 0 }, { x: 8, y: 0 })).toBe(false) // exactly 8 px is a drag
  })

  it('is direction-agnostic', () => {
    expect(isClick({ x: 50, y: 50 }, { x: 45, y: 45 })).toBe(true)
    expect(isClick({ x: 50, y: 50 }, { x: 20, y: 50 })).toBe(false)
  })
})
