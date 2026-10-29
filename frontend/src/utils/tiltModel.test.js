import { describe, it, expect } from 'vitest'
import {
  DEFAULT_HINGE,
  DEFAULT_PROFILE,
  HINGE_MODES,
  buildTiltModel,
  describeTiltModel,
  formatNumber,
  guardNote,
  normalizeHingeMode,
  parseFiniteNumber,
  parsePositiveNumber,
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

describe('the profile defaults', () => {
  it('are empty fields: a rate and a formula, nothing pre-filled', () => {
    expect(DEFAULT_PROFILE).toEqual({ family: 'linear', rateOfIncrease: '', formula: '' })
  })
})

describe('tiltModelIssues (only the active family is required)', () => {
  it('is clean for the default linear profile', () => {
    expect(tiltModelIssues(adv())).toEqual([])
  })

  it('quadratic: needs a finite rate; a typed formula is irrelevant', () => {
    const q = (patch) => tiltModelIssues(adv({ family: 'quadratic', ...patch }))
    expect(q({})).toEqual(['a rate of increase (a number)'])
    expect(q({ rateOfIncrease: 'abc' })).toHaveLength(1)
    expect(q({ rateOfIncrease: '0' })).toEqual([])
    expect(q({ rateOfIncrease: '4e-3', formula: 'junk' })).toEqual([])
  })

  it('polynomial: needs a formula that parses, and says why when it does not', () => {
    const q = (patch) => tiltModelIssues(adv({ family: 'polynomial', ...patch }))
    expect(q({})).toEqual(['a polynomial formula'])
    expect(q({ formula: '2e-4 x^2' })).toEqual([])
    expect(q({ formula: '2e-4 x^2', rateOfIncrease: 'abc' })).toEqual([])
    expect(q({ formula: '2e-4 x^7' })).toEqual([
      'a valid polynomial formula (Exponents must be whole numbers from 2 to 5.)'
    ])
  })

  it('a distance hinge needs a positive distance', () => {
    expect(tiltModelIssues(adv({}, { mode: 'distance' }))).toEqual(['a hinge distance greater than 0'])
    expect(tiltModelIssues(adv({}, { mode: 'distance', distanceKm: '30' }))).toEqual([])
    expect(tiltModelIssues(adv({}, { mode: 'none', distanceKm: 'abc' }))).toEqual([])
  })
})

describe('buildTiltModel', () => {
  it('sends only the active family\'s field', () => {
    const quad = buildTiltModel(adv({ family: 'quadratic', rateOfIncrease: '4e-3', formula: '1 x^2' }))
    expect(quad.profile).toEqual({ family: 'quadratic', rate_of_increase: 0.004, formula: null })
    const poly = buildTiltModel(adv({ family: 'polynomial', rateOfIncrease: '7', formula: '2e-4 x^2' }))
    expect(poly.profile).toEqual({ family: 'polynomial', rate_of_increase: null, formula: '2e-4 x^2' })
  })

  it("defaults the hinge to 'origin' for every family", () => {
    for (const family of ['linear', 'quadratic', 'polynomial']) {
      expect(buildTiltModel(adv({ family })).hinge).toEqual({ mode: 'origin', distance_km: null })
    }
  })
})

describe('describeTiltModel', () => {
  it('quadratic, with the guard clause', () => {
    const a = adv({ family: 'quadratic', rateOfIncrease: '4e-3' }, { mode: 'none' })
    expect(describeTiltModel(a, -53.9, 'guard')).toBe('Quadratic, k = 4e-3 · hinge none, zero gradient at −53.9 km')
  })

  it('quadratic, hinge at the spillway (no clause when the mode set the clamp)', () => {
    const a = adv({ family: 'quadratic', rateOfIncrease: '4e-3' })
    expect(describeTiltModel(a, 0, 'mode')).toBe('Quadratic, k = 4e-3 · hinge at spillway')
  })

  it('linear and distance hinge; a polynomial shows its formula', () => {
    expect(describeTiltModel(adv(), 0, 'mode')).toBe('Linear · hinge at spillway')
    expect(describeTiltModel(adv({}, { mode: 'distance', distanceKm: '30' }), -30, 'mode')).toBe(
      'Linear · hinge 30 km behind spillway'
    )
    expect(
      describeTiltModel(adv({ family: 'polynomial', formula: ' 2e-4 x^2 - 1e-7 x^3 ' }, { mode: 'none' }), null, null)
    ).toBe('Polynomial, 2e-4 x^2 - 1e-7 x^3 · hinge none')
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
