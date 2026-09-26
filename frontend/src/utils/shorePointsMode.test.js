// Shore-points direction source (spec 6): readiness, payload and description rules.
import { describe, it, expect } from 'vitest'
import { getReadiness } from './readiness.js'
import { buildProcessPayload } from './payload.js'
import {
  DEFAULT_HINGE,
  DEFAULT_PROFILE,
  buildTiltModel,
  describeTiltModel,
  directionSourceOf,
  tiltModelIssues,
  usingPoints
} from './tiltModel.js'
import { classifyErrorStep } from './steps.js'
import { newShorePoint } from './shorePoints.js'

const pts = (n) => Array.from({ length: n }, (_, i) => newShorePoint({ lat: String(45 + i / 50), lon: '-104.9', elevationM: String(300 + i) }))

function advanced(count, extra = {}) {
  return {
    sectionsOpen: {},
    profile: DEFAULT_PROFILE,
    hinge: DEFAULT_HINGE,
    directionSource: 'points',
    vectors: [],
    shorePoints: pts(count),
    surface: { order: 2, hinge: 'none', extrapolation: 'warn' },
    ...extra
  }
}

// A form that is otherwise ready to run (points mode, Advanced), with a typed
// azimuth and gradient left over from another source.
function form(count, patch = {}, advancedExtra = {}) {
  return {
    mode: 'advanced',
    preflightStatus: 'valid',
    demFile: null,
    demPath: '/data/dem.tif',
    originMode: 'decimal_degrees',
    originValue: '45, -105',
    originEpsg: '',
    tiltAzimuth: '28',
    tiltFactor: '0.35',
    targetElevation: '1500',
    elevationCheckStatus: 'dem',
    selectionRadiusKm: '',
    includeDem: true,
    advanced: advanced(count, advancedExtra),
    ...patch
  }
}

describe('direction source', () => {
  it('accepts points, and only in Advanced mode counts as using them', () => {
    expect(directionSourceOf({ directionSource: 'points' })).toBe('points')
    expect(directionSourceOf({ directionSource: 'nope' })).toBe('azimuth')
    expect(usingPoints(form(9))).toBe(true)
    expect(usingPoints(form(9, { mode: 'basic' }))).toBe(false)
  })
})

describe('getReadiness in points mode', () => {
  it('needs neither a tilt azimuth nor a tilt factor', () => {
    const r = getReadiness(form(9, { tiltAzimuth: '', tiltFactor: '' }))
    expect(r.ready).toBe(true)
    expect(r.missingText).not.toContain('tilt azimuth')
    expect(r.missingText).not.toContain('tilt factor')
  })

  it('needs the minimum point count for the chosen order, keyed to the tilt section', () => {
    const r = getReadiness(form(8))
    expect(r.ready).toBe(false)
    expect(r.missing).toContainEqual({
      section: 'tilt',
      text: 'at least 9 shore points for an order-2 surface (or choose a lower order)'
    })
    // ...and a lower order is enough with fewer points.
    expect(getReadiness(form(8, {}, { surface: { order: 1, hinge: 'none', extrapolation: 'warn' } })).ready).toBe(true)
    expect(getReadiness(form(9, {}, { surface: { order: 3, hinge: 'none', extrapolation: 'warn' } })).ready).toBe(false)
    expect(getReadiness(form(13, {}, { surface: { order: 3, hinge: 'none', extrapolation: 'warn' } })).ready).toBe(true)
  })

  it('needs every point valid', () => {
    const bad = pts(9)
    bad[3] = { ...bad[3], elevationM: 'abc' }
    const r = getReadiness(form(9, {}, { shorePoints: bad }))
    expect(r.missing).toContainEqual({
      section: 'tilt',
      text: 'a valid latitude, longitude and elevation for point 4'
    })
  })

  it('never affects Basic mode, which still needs its azimuth and factor', () => {
    const r = getReadiness(form(0, { mode: 'basic', tiltAzimuth: '', tiltFactor: '' }))
    expect(r.missingText).toEqual(expect.arrayContaining(['tilt azimuth', 'tilt factor']))
    expect(r.missingText.join(' ')).not.toContain('shore point')
  })

  it('ignores a leftover single-azimuth profile that would be invalid', () => {
    const profile = { ...DEFAULT_PROFILE, family: 'quadratic', secondGradient: '', secondGradientDistanceKm: '' }
    expect(tiltModelIssues(advanced(9, { profile }))).toEqual([])
  })
})

describe('buildTiltModel / buildProcessPayload in points mode', () => {
  it('omits the top-level profile and hinge', () => {
    const model = buildTiltModel(advanced(9))
    expect(Object.keys(model).sort()).toEqual(['direction', 'version'])
    expect(model.direction).toMatchObject({ type: 'points', order: 2, hinge: 'none', extrapolation: 'warn' })
    expect(model.direction.points).toHaveLength(9)
    expect('profile' in model).toBe(false)
    expect('hinge' in model).toBe(false)
  })

  it('carries the options', () => {
    const model = buildTiltModel(advanced(13, { surface: { order: 3, hinge: 'origin', extrapolation: 'mask' } }))
    expect(model.direction).toMatchObject({ order: 3, hinge: 'origin', extrapolation: 'mask' })
  })

  it('the process payload sends no tilt_azimuth or tilt_factor, and the model as JSON', () => {
    const payload = buildProcessPayload(form(9))
    expect('tilt_azimuth' in payload).toBe(false)
    expect('tilt_factor' in payload).toBe(false)
    const model = JSON.parse(payload.tilt_model)
    expect(model.direction.type).toBe('points')
    expect('profile' in model || 'hinge' in model).toBe(false)
  })

  it('keeps the site names in the payload', () => {
    const list = pts(9)
    list[0] = { ...list[0], label: 'Pit 7' }
    const model = JSON.parse(buildProcessPayload(form(9, {}, { shorePoints: list })).tilt_model)
    expect(model.direction.points[0].label).toBe('Pit 7')
    expect('label' in model.direction.points[1]).toBe(false)
  })

  it('a Basic run never sees shore points', () => {
    const payload = buildProcessPayload(form(9, { mode: 'basic' }))
    expect(payload.tilt_azimuth).toBe('28')
    expect('tilt_model' in payload).toBe(false)
  })
})

describe('describeTiltModel in points mode', () => {
  it('summarizes the surface and, when known, its fit', () => {
    expect(describeTiltModel(advanced(9))).toBe(
      'Order-2 surface from 9 shore points · behind spillway: apply surface as fitted · outside the data: warn'
    )
    expect(
      describeTiltModel(advanced(6, { surface: { order: 1, hinge: 'origin', extrapolation: 'mask' } }), undefined, undefined, {
        rmse_m: 1.234,
        r2: 0.98765
      })
    ).toBe(
      'Order-1 surface from 6 shore points, RMSE 1.23 m, R² 0.988 · behind spillway: no change behind origin · outside the data: mask (no contours)'
    )
  })
})

describe('error routing', () => {
  it('sends surface errors to the tilt section', () => {
    expect(classifyErrorStep('An order-2 surface needs at least 9 shore points (got 8); add points.')).toBe('tilt')
    expect(classifyErrorStep("The DEM lies entirely outside the shore points' buffered hull; masking would remove every cell.")).toBe('tilt')
    expect(classifyErrorStep('The shore points must not all be at the same location.')).toBe('tilt')
  })
})
