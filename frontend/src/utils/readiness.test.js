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

describe('parseSelectionRadiusKm', () => {
  it('returns the number for valid values and null otherwise', () => {
    expect(parseSelectionRadiusKm('12.5')).toBe(12.5)
    for (const bad of ['', '0', '-3', 'abc', 'Infinity', null, undefined]) {
      expect(parseSelectionRadiusKm(bad)).toBeNull()
    }
  })
})
