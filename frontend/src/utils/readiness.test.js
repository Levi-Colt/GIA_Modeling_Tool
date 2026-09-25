import { describe, it, expect } from 'vitest'
import { getReadiness, isReadyToRun, parseSelectionRadiusKm } from './readiness.js'

const completeForm = {
  preflightStatus: 'valid',
  originMode: 'decimal_degrees',
  originValue: '40.0, -105.0',
  originEpsg: '',
  tiltAzimuth: '45',
  tiltFactor: '0.5',
  targetElevation: '1500',
  elevationCheckStatus: 'dem',
  selectionRadiusKm: ''
}

// Every case also checks that isReadyToRun agrees with getReadiness().ready.
function check(form) {
  const result = getReadiness(form)
  expect(isReadyToRun(form)).toBe(result.ready)
  return result
}

describe('getReadiness', () => {
  it('lists every reason for an empty form', () => {
    const { ready, missingText: missing } = check({
      preflightStatus: 'idle',
      originMode: 'epsg',
      originValue: '',
      originEpsg: '',
      tiltAzimuth: '',
      tiltFactor: '',
      targetElevation: '',
      elevationCheckStatus: 'idle',
      selectionRadiusKm: ''
    })
    expect(ready).toBe(false)
    expect(missing).toEqual([
      'a valid DEM',
      'origin coordinates',
      'origin EPSG code',
      'tilt azimuth',
      'tilt factor',
      'target elevation',
      'origin elevation check (click out of the coordinate field)'
    ])
  })

  it('is ready with nothing missing for a complete form', () => {
    expect(check(completeForm)).toEqual({ ready: true, missing: [], missingText: [] })
  })

  it('reports each individual gap on its own', () => {
    expect(check({ ...completeForm, preflightStatus: 'invalid' }).missingText).toEqual(['a valid DEM'])
    expect(check({ ...completeForm, originValue: '' }).missingText).toEqual(['origin coordinates'])
    expect(check({ ...completeForm, originMode: 'epsg' }).missingText).toEqual(['origin EPSG code'])
    expect(check({ ...completeForm, originMode: 'epsg', originEpsg: '32612' }).ready).toBe(true)
    expect(check({ ...completeForm, tiltAzimuth: '' }).missingText).toEqual(['tilt azimuth'])
    expect(check({ ...completeForm, tiltFactor: '' }).missingText).toEqual(['tilt factor'])
    expect(check({ ...completeForm, targetElevation: '' }).missingText).toEqual(['target elevation'])
  })

  it('gates on the origin elevation check being idle or in flight', () => {
    expect(check({ ...completeForm, elevationCheckStatus: 'idle' }).missingText).toEqual([
      'origin elevation check (click out of the coordinate field)'
    ])
    expect(check({ ...completeForm, elevationCheckStatus: 'checking' }).missingText).toEqual([
      'origin elevation check in progress'
    ])
    for (const status of ['dem', 'outside_bounds', 'nodata']) {
      expect(check({ ...completeForm, elevationCheckStatus: status }).ready).toBe(true)
    }
  })

  it('keys every reason to its form section', () => {
    const { missing } = check({
      preflightStatus: 'idle',
      originMode: 'epsg',
      originValue: '',
      originEpsg: '',
      tiltAzimuth: '',
      tiltFactor: '',
      targetElevation: '',
      elevationCheckStatus: 'idle',
      selectionRadiusKm: '-1'
    })
    expect(missing).toEqual([
      { section: 'dem', text: 'a valid DEM' },
      { section: 'origin', text: 'origin coordinates' },
      { section: 'origin', text: 'origin EPSG code' },
      { section: 'tilt', text: 'tilt azimuth' },
      { section: 'tilt', text: 'tilt factor' },
      { section: 'origin', text: 'target elevation' },
      { section: 'origin', text: 'origin elevation check (click out of the coordinate field)' },
      { section: 'output', text: 'a positive selection radius (or leave it empty)' }
    ])
  })

  it('gives the same result in both modes, and ignores formState.advanced', () => {
    const basic = getReadiness({ ...completeForm, mode: 'basic', tiltAzimuth: '' })
    const advanced = getReadiness({ ...completeForm, mode: 'advanced', tiltAzimuth: '' })
    const withJunk = getReadiness({ ...completeForm, mode: 'basic', tiltAzimuth: '', advanced: { anything: 'x' } })
    expect(advanced).toEqual(basic)
    expect(withJunk).toEqual(basic)
  })

  describe('selection radius', () => {
    const reason = 'a positive selection radius (or leave it empty)'

    it('allows an empty (or absent) radius', () => {
      expect(check({ ...completeForm, selectionRadiusKm: '' }).ready).toBe(true)
      const { selectionRadiusKm, ...withoutField } = completeForm
      expect(check(withoutField).ready).toBe(true)
    })

    it.each(['0', '-1', 'abc'])('blocks %s with the radius reason', (value) => {
      expect(check({ ...completeForm, selectionRadiusKm: value }).missingText).toEqual([reason])
    })

    it('allows a positive radius', () => {
      expect(check({ ...completeForm, selectionRadiusKm: '12.5' }).ready).toBe(true)
    })
  })
})

describe('getReadiness: Advanced tilt model', () => {
  const advancedForm = (profile = {}, hinge = {}) => ({
    ...completeForm,
    mode: 'advanced',
    advanced: {
      profile: {
        family: 'linear',
        curvatureInput: 'secondGradient',
        rateOfIncrease: '',
        secondGradient: '',
        secondGradientDistanceKm: '',
        coefficients: ['', '', '', ''],
        degree: 3,
        ...profile
      },
      hinge: { mode: 'origin', distanceKm: '', ...hinge }
    }
  })
  const tiltReasons = (form) => check(form).missing.filter((m) => m.section === 'tilt').map((m) => m.text)
  const byRate = (rateOfIncrease, extra = {}) =>
    advancedForm({ family: 'quadratic', curvatureInput: 'rate', rateOfIncrease, ...extra })
  const bySecond = (secondGradient, secondGradientDistanceKm, extra = {}) =>
    advancedForm({ family: 'quadratic', curvatureInput: 'secondGradient', secondGradient, secondGradientDistanceKm, ...extra })

  it('is ready for the default linear profile', () => {
    expect(check(advancedForm()).ready).toBe(true)
  })

  it('quadratic by rate requires a finite rate', () => {
    for (const bad of ['', '  ', 'abc', 'Infinity', '1,5', '0x10', '1e']) {
      expect(tiltReasons(byRate(bad))).toHaveLength(1)
    }
    for (const good of ['0.004', '4e-3', '-0.002', '.5', '0']) {
      expect(check(byRate(good)).ready).toBe(true)
    }
  })

  it('quadratic by second gradient requires a finite gradient and a positive distance', () => {
    expect(tiltReasons(bySecond('', ''))).toHaveLength(2)
    expect(tiltReasons(bySecond('1.2', ''))).toHaveLength(1)
    expect(tiltReasons(bySecond('', '150'))).toHaveLength(1)
    for (const badDistance of ['0', '-5', 'abc']) expect(check(bySecond('1.2', badDistance)).ready).toBe(false)
    expect(check(bySecond('1.2', '150')).ready).toBe(true)
    expect(check(bySecond('-0.3', '150')).ready).toBe(true)
  })

  it('only the active curvature form is required', () => {
    // Active = rate: the (empty/junk) second-gradient fields are ignored.
    expect(check(byRate('4e-3', { secondGradient: 'junk', secondGradientDistanceKm: '-1' })).ready).toBe(true)
    // Active = second gradient: the (empty/junk) rate is ignored.
    expect(check(bySecond('1.2', '150', { rateOfIncrease: 'abc' })).ready).toBe(true)
    // ...and each active form is still enforced when the other is filled in.
    expect(check(byRate('', { secondGradient: '1.2', secondGradientDistanceKm: '150' })).ready).toBe(false)
    expect(check(bySecond('', '', { rateOfIncrease: '4e-3' })).ready).toBe(false)
  })

  it('polynomial requires c2..c_degree all finite, and ignores slots past the degree', () => {
    const poly = (degree, coefficients) => advancedForm({ family: 'polynomial', degree, coefficients })
    expect(check(poly(3, ['0.1', '', '', ''])).ready).toBe(false)
    expect(check(poly(3, ['0.1', 'x', '', ''])).ready).toBe(false)
    expect(check(poly(3, ['0.1', '0.2', '', ''])).ready).toBe(true)
    expect(check(poly(2, ['0.1', 'junk', 'junk', 'junk'])).ready).toBe(true)
    expect(check(poly(5, ['1', '2', '3', ''])).ready).toBe(false)
    expect(check(poly(5, ['1', '2', '3', '4'])).ready).toBe(true)
  })

  it('a distance hinge requires distanceKm > 0; other modes never look at it', () => {
    const dist = (distanceKm) => advancedForm({}, { mode: 'distance', distanceKm })
    for (const bad of ['', '0', '-5', 'abc']) expect(check(dist(bad)).ready).toBe(false)
    expect(check(dist('30')).ready).toBe(true)
    expect(check(advancedForm({}, { mode: 'origin', distanceKm: 'abc' })).ready).toBe(true)
    expect(check(advancedForm({}, { mode: 'none', distanceKm: 'abc' })).ready).toBe(true)
  })

  it('keys every new reason to the tilt section', () => {
    const { missing } = check(bySecond('', '', { family: 'quadratic' }))
    expect(missing.map((m) => m.section)).toEqual(['tilt', 'tilt'])
    const both = check({ ...byRate(''), advanced: { ...byRate('').advanced, hinge: { mode: 'distance', distanceKm: '' } } })
    expect(both.missing.map((m) => m.section)).toEqual(['tilt', 'tilt'])
  })

  it('Basic readiness ignores advanced.profile and advanced.hinge entirely', () => {
    const bad = advancedForm({ family: 'quadratic', curvatureInput: 'rate', rateOfIncrease: 'abc' }, { mode: 'distance', distanceKm: '' })
    expect(check({ ...bad, mode: 'basic' })).toEqual(check(completeForm))
    expect(check({ ...bad, mode: 'basic' }).ready).toBe(true)
  })
})

describe('parseSelectionRadiusKm', () => {
  it('returns the number for valid values and null otherwise', () => {
    expect(parseSelectionRadiusKm('12.5')).toBe(12.5)
    for (const bad of ['', '0', '-3', 'abc', 'Infinity', null, undefined]) {
      expect(parseSelectionRadiusKm(bad)).toBeNull()
    }
  })
})
