import { describe, it, expect } from 'vitest'
import { formatDecimalDegrees, roundedLonLat } from './origin.js'

describe('formatDecimalDegrees', () => {
  it('writes hemisphere-annotated decimal degrees, latitude first', () => {
    expect(formatDecimalDegrees(-110.55, 45.25)).toBe('45.25000N, 110.55000W')
    expect(formatDecimalDegrees(34.25, -12.5)).toBe('12.50000S, 34.25000E')
  })

  it('wraps a longitude panned past the antimeridian into [-180, 180]', () => {
    expect(formatDecimalDegrees(190, 0)).toBe('0.00000N, 170.00000W')
    expect(formatDecimalDegrees(-190, 0)).toBe('0.00000N, 170.00000E')
  })

  it('round-trips through the form the API parses (magnitude + N/S/E/W)', () => {
    expect(formatDecimalDegrees(-110.123456789, 45.987654321)).toMatch(/^\d+(\.\d+)?[NS], \d+(\.\d+)?[EW]$/)
  })
})

describe('roundedLonLat', () => {
  it('matches the digits the formatted string carries', () => {
    expect(roundedLonLat(-110.123456789, 45.987654321)).toEqual([-110.12346, 45.98765])
  })
})
