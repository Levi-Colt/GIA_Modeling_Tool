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
    const { ready, missing } = check({
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
    expect(check(completeForm)).toEqual({ ready: true, missing: [] })
  })

  it('reports each individual gap on its own', () => {
    expect(check({ ...completeForm, preflightStatus: 'invalid' }).missing).toEqual(['a valid DEM'])
    expect(check({ ...completeForm, originValue: '' }).missing).toEqual(['origin coordinates'])
    expect(check({ ...completeForm, originMode: 'epsg' }).missing).toEqual(['origin EPSG code'])
    expect(check({ ...completeForm, originMode: 'epsg', originEpsg: '32612' }).ready).toBe(true)
    expect(check({ ...completeForm, tiltAzimuth: '' }).missing).toEqual(['tilt azimuth'])
    expect(check({ ...completeForm, tiltFactor: '' }).missing).toEqual(['tilt factor'])
    expect(check({ ...completeForm, targetElevation: '' }).missing).toEqual(['target elevation'])
  })

  it('gates on the origin elevation check being idle or in flight', () => {
    expect(check({ ...completeForm, elevationCheckStatus: 'idle' }).missing).toEqual([
      'origin elevation check (click out of the coordinate field)'
    ])
    expect(check({ ...completeForm, elevationCheckStatus: 'checking' }).missing).toEqual([
      'origin elevation check in progress'
    ])
    for (const status of ['dem', 'outside_bounds', 'nodata']) {
      expect(check({ ...completeForm, elevationCheckStatus: status }).ready).toBe(true)
    }
  })

  describe('selection radius', () => {
    const reason = 'a positive selection radius (or leave it empty)'

    it('allows an empty (or absent) radius', () => {
      expect(check({ ...completeForm, selectionRadiusKm: '' }).ready).toBe(true)
      const { selectionRadiusKm, ...withoutField } = completeForm
      expect(check(withoutField).ready).toBe(true)
    })

    it.each(['0', '-1', 'abc'])('blocks %s with the radius reason', (value) => {
      expect(check({ ...completeForm, selectionRadiusKm: value }).missing).toEqual([reason])
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
