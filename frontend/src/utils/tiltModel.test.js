import { describe, it, expect } from 'vitest'
import {
  DEFAULT_HINGE,
  DEFAULT_PROFILE,
  HINGE_MODES,
  buildTiltModel,
  curvatureForm,
  describeTiltModel,
  extraCoefficientCount,
  formatNumber,
  guardNote,
  normalizeHingeMode,
  parseFiniteNumber,
  parsePositiveNumber,
  parseSecondGradient,
  tiltModelIssues
} from './tiltModel.js'

const adv = (profile = {}, hinge = {}) => ({
  profile: { ...DEFAULT_PROFILE, ...profile },
  hinge: { ...DEFAULT_HINGE, ...hinge }
})

describe('parseFiniteNumber / parsePositiveNumber', () => {
  it('accepts plain, signed, decimal and exponent notation', () => {
    expect(parseFiniteNumber('4e-3')).toBe(0.004)
    expect(parseFiniteNumber('  -3 ')).toBe(-3)
    expect(parseFiniteNumber('+.5')).toBe(0.5)
    expect(parseFiniteNumber('2E3')).toBe(2000)
    expect(parseFiniteNumber('0')).toBe(0)
    expect(parseFiniteNumber(4)).toBe(4)
  })

  it('rejects everything else, notably the empty string (Number("") is 0)', () => {
    for (const bad of ['', ' ', 'abc', '1e', 'e5', '1,5', '0x10', 'Infinity', 'NaN', '1 2', null, undefined, NaN, {}]) {
      expect(parseFiniteNumber(bad)).toBeNull()
    }
    expect(parseFiniteNumber('1e999')).toBeNull() // overflows to Infinity
  })

  it('parsePositiveNumber also rejects zero and negatives', () => {
    expect(parsePositiveNumber('150')).toBe(150)
    for (const bad of ['0', '-1', '', 'abc']) expect(parsePositiveNumber(bad)).toBeNull()
  })
})

describe('hinge modes', () => {
  it('offers exactly origin | distance | none, with origin as the labelled default', () => {
    expect(HINGE_MODES.map((m) => m.value)).toEqual(['origin', 'distance', 'none'])
    expect(HINGE_MODES.map((m) => m.label)).toEqual([
      'At spillway (default)',
      'Distance behind spillway…',
      'None: continue behind spillway'
    ])
    expect(DEFAULT_HINGE.mode).toBe('origin')
  })

  it("has no 'default' or 'natural' value anywhere", () => {
    expect(JSON.stringify([HINGE_MODES, DEFAULT_HINGE])).not.toMatch(/default'|"default"|natural/)
  })

  it("normalizes unknown or removed modes to 'origin'", () => {
    for (const legacy of ['default', 'natural', 'midpoint', '', undefined, null]) {
      expect(normalizeHingeMode(legacy)).toBe('origin')
    }
    expect(normalizeHingeMode('distance')).toBe('distance')
    expect(normalizeHingeMode('none')).toBe('none')
    expect(normalizeHingeMode('origin')).toBe('origin')
  })
})

describe('extraCoefficientCount / curvatureForm / parseSecondGradient', () => {
  it('clamps the coefficient count to degree 2-5', () => {
    expect(extraCoefficientCount({ degree: 2 })).toBe(1)
    expect(extraCoefficientCount({ degree: 5 })).toBe(4)
    expect(extraCoefficientCount({ degree: 99 })).toBe(4)
    expect(extraCoefficientCount({ degree: 'x' })).toBe(2)
  })

  it('curvature defaults to the second-gradient form unless explicitly "rate"', () => {
    expect(DEFAULT_PROFILE.curvatureInput).toBe('secondGradient')
    expect(curvatureForm({})).toBe('secondGradient')
    expect(curvatureForm({ curvatureInput: 'rate' })).toBe('rate')
    expect(curvatureForm({ curvatureInput: 'junk' })).toBe('secondGradient')
  })

  it('parses a second gradient only when both fields are valid', () => {
    expect(parseSecondGradient({ secondGradient: '1.2', secondGradientDistanceKm: '150' })).toEqual({
      gradient: 1.2,
      distanceKm: 150
    })
    expect(parseSecondGradient({ secondGradient: '1.2', secondGradientDistanceKm: '0' })).toBeNull()
    expect(parseSecondGradient({ secondGradient: '', secondGradientDistanceKm: '150' })).toBeNull()
  })
})

describe('tiltModelIssues (only the active curvature form is required)', () => {
  it('is clean for the default linear profile', () => {
    expect(tiltModelIssues(adv())).toEqual([])
  })

  it('second-gradient form: needs the gradient and a positive distance', () => {
    const q = (patch) => tiltModelIssues(adv({ family: 'quadratic', ...patch }))
    expect(q({})).toHaveLength(2)
    expect(q({ secondGradient: '1.2' })).toEqual(['a distance for the second gradient (greater than 0)'])
    expect(q({ secondGradient: '1.2', secondGradientDistanceKm: '0' })).toHaveLength(1)
    expect(q({ secondGradient: '1.2', secondGradientDistanceKm: '150' })).toEqual([])
    // A junk rate in the hidden form is irrelevant.
    expect(q({ secondGradient: '1.2', secondGradientDistanceKm: '150', rateOfIncrease: 'abc' })).toEqual([])
  })

  it('rate form: needs a finite rate; the hidden second-gradient fields are irrelevant', () => {
    const q = (patch) => tiltModelIssues(adv({ family: 'quadratic', curvatureInput: 'rate', ...patch }))
    expect(q({})).toEqual(['a rate of increase (a number)'])
    expect(q({ rateOfIncrease: 'abc' })).toHaveLength(1)
    expect(q({ rateOfIncrease: '0' })).toEqual([])
    expect(q({ rateOfIncrease: '4e-3', secondGradient: 'junk', secondGradientDistanceKm: '-5' })).toEqual([])
  })

  it('a distance hinge needs a positive distance', () => {
    expect(tiltModelIssues(adv({}, { mode: 'distance' }))).toEqual(['a hinge distance greater than 0'])
    expect(tiltModelIssues(adv({}, { mode: 'distance', distanceKm: '30' }))).toEqual([])
    expect(tiltModelIssues(adv({}, { mode: 'none', distanceKm: 'abc' }))).toEqual([])
  })
})

describe('buildTiltModel', () => {
  it('sends only the active curvature form', () => {
    const rate = buildTiltModel(
      adv({
        family: 'quadratic', curvatureInput: 'rate', rateOfIncrease: '4e-3',
        secondGradient: '9', secondGradientDistanceKm: '9'
      })
    )
    expect(rate.profile).toEqual({
      family: 'quadratic', rate_of_increase: 0.004, second_gradient: null, coefficients: null
    })
    const second = buildTiltModel(
      adv({
        family: 'quadratic', curvatureInput: 'secondGradient', rateOfIncrease: '7',
        secondGradient: '1.2', secondGradientDistanceKm: '150'
      })
    )
    expect(second.profile).toEqual({
      family: 'quadratic',
      rate_of_increase: null,
      second_gradient: { gradient_m_per_km: 1.2, distance_km: 150 },
      coefficients: null
    })
  })

  it("defaults the hinge to 'origin' for every family", () => {
    for (const family of ['linear', 'quadratic', 'polynomial']) {
      expect(buildTiltModel(adv({ family })).hinge).toEqual({ mode: 'origin', distance_km: null })
    }
  })
})

describe('describeTiltModel', () => {
  it('quadratic by second gradient, with the guard clause', () => {
    const a = adv({ family: 'quadratic', secondGradient: '1.2', secondGradientDistanceKm: '150' }, { mode: 'none' })
    expect(describeTiltModel(a, -53.9, 'guard')).toBe(
      'Quadratic, second gradient 1.2 m/km at 150 km · hinge none, zero gradient at −53.9 km'
    )
  })

  it('quadratic by rate, hinge at the spillway (no clause when the mode set the clamp)', () => {
    const a = adv({ family: 'quadratic', curvatureInput: 'rate', rateOfIncrease: '4e-3' })
    expect(describeTiltModel(a, 0, 'mode')).toBe('Quadratic, k = 4e-3 · hinge at spillway')
  })

  it('linear and distance hinge; polynomial names its degree', () => {
    expect(describeTiltModel(adv(), 0, 'mode')).toBe('Linear · hinge at spillway')
    expect(describeTiltModel(adv({}, { mode: 'distance', distanceKm: '30' }), -30, 'mode')).toBe(
      'Linear · hinge 30 km behind spillway'
    )
    expect(describeTiltModel(adv({ family: 'polynomial', degree: 4 }, { mode: 'none' }), null, null)).toBe(
      'Polynomial, degree 4 · hinge none'
    )
  })

  it('drops the guard clause without a preview', () => {
    expect(describeTiltModel(adv({}, { mode: 'none' }), undefined, undefined)).toBe('Linear · hinge none')
  })
})

describe('guardNote / formatNumber', () => {
  it('states the guard as information, in spillway terms', () => {
    expect(guardNote(-53.9)).toBe(
      "The profile's gradient reaches zero 53.9 km behind the spillway; uplift is held constant beyond that point."
    )
  })

  it('formatNumber uses a real minus sign and trims noise', () => {
    expect(formatNumber(-54.00001)).toBe('−54')
    expect(formatNumber(310.4)).toBe('310')
    expect(formatNumber(0.004123)).toBe('0.00412')
    expect(formatNumber(NaN)).toBe('')
  })
})
