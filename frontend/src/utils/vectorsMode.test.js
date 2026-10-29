// Vectors direction source (spec 5): readiness, payload and description rules.
import { describe, it, expect } from 'vitest'
import { getReadiness } from './readiness.js'
import { buildProcessPayload } from './payload.js'
import { DEFAULT_HINGE, DEFAULT_PROFILE, buildTiltModel, describeTiltModel, tiltModelIssues } from './tiltModel.js'
import { newVector } from './vectors.js'

const vec = (patch = {}) => newVector({ lat: '45', lon: '-105', azimuthDeg: '30', ...patch })

function advanced(vectors, extra = {}) {
  return {
    sectionsOpen: {},
    profile: DEFAULT_PROFILE,
    hinge: DEFAULT_HINGE,
    directionSource: 'vectors',
    vectors,
    ...extra
  }
}

// A form that is otherwise ready to run (vectors mode, Advanced).
function form(vectors, patch = {}, advancedExtra = {}) {
  return {
    mode: 'advanced',
    preflightStatus: 'valid',
    demFile: null,
    demPath: '/data/dem.tif',
    originValue: '45, -105',
      tiltAzimuth: '',
    tiltFactor: '0.35',
    targetElevation: '1500',
    elevationCheckStatus: 'dem',
    selectionRadiusKm: '',
    includeDem: true,
    advanced: advanced(vectors, advancedExtra),
    ...patch
  }
}

describe('getReadiness in vectors mode', () => {
  it('does not need a single azimuth', () => {
    const r = getReadiness(form([vec()]))
    expect(r.ready).toBe(true)
    expect(r.missingText).not.toContain('tilt azimuth')
  })

  it('needs at least one vector, keyed to the tilt section', () => {
    const r = getReadiness(form([]))
    expect(r.ready).toBe(false)
    expect(r.missing).toContainEqual({ section: 'tilt', text: 'at least one vector' })
  })

  it('always needs the gradient at the spillway (the profile gives the magnitude everywhere)', () => {
    expect(getReadiness(form([vec()], { tiltFactor: '' })).missing).toContainEqual({
      section: 'tilt',
      text: 'the gradient at the spillway'
    })
    expect(getReadiness(form([vec(), vec()], { tiltFactor: '' })).ready).toBe(false)
  })

  it('reports invalid rows in the tilt section', () => {
    const r = getReadiness(form([vec({ azimuthDeg: '' }), vec({ lat: '95' })]))
    const tilt = r.missing.filter((m) => m.section === 'tilt').map((m) => m.text)
    expect(tilt).toEqual(['a valid latitude, longitude and azimuth for vectors 1, 2'])
  })

  it('the profile fields are required in vectors mode, like any other', () => {
    const quadratic = { profile: { ...DEFAULT_PROFILE, family: 'quadratic' } } // rate empty
    expect(getReadiness(form([vec()], {}, quadratic)).missingText).toContain('a rate of increase (a number)')
    const poly = { profile: { ...DEFAULT_PROFILE, family: 'polynomial', formula: '2e-4 x^2' } }
    expect(getReadiness(form([vec()], {}, poly)).ready).toBe(true)
  })

  it('the hinge distance is required when that hinge mode is chosen', () => {
    const r = getReadiness(form([vec()], {}, { hinge: { mode: 'distance', distanceKm: '' } }))
    expect(r.missingText).toContain('a hinge distance greater than 0')
  })

  it('still needs the DEM, origin and target elevation, like every mode', () => {
    const r = getReadiness(form([vec()], { preflightStatus: 'idle', originValue: '' }))
    expect(r.missing.map((m) => m.section)).toEqual(expect.arrayContaining(['dem', 'origin']))
  })

  it('never changes Basic readiness: advanced vectors are ignored there', () => {
    const basic = { ...form([]), mode: 'basic', tiltAzimuth: '45' }
    expect(getReadiness(basic).ready).toBe(true)
    expect(getReadiness({ ...basic, tiltAzimuth: '' }).missingText).toContain('tilt azimuth')
  })

  it('the single-azimuth source still requires an azimuth', () => {
    const r = getReadiness(form([], { tiltAzimuth: '' }, { directionSource: 'azimuth' }))
    expect(r.missingText).toContain('tilt azimuth')
    expect(r.missingText).not.toContain('at least one vector')
  })
})

describe('buildProcessPayload in vectors mode', () => {
  const tm = (f) => JSON.parse(buildProcessPayload(f).tilt_model)

  it('sends direction.type vectors with each vector as numbers, and omits tilt_azimuth', () => {
    const f = form([vec({ rangeKm: '150' }), vec({ azimuthDeg: '10', rangeKm: '' })], { tiltAzimuth: '99' })
    const payload = buildProcessPayload(f)
    expect(payload).not.toHaveProperty('tilt_azimuth') // even if a stale value is in state
    expect(payload.tilt_factor).toBe('0.35')
    const model = JSON.parse(payload.tilt_model)
    expect(model.direction).toEqual({
      type: 'vectors',
      vectors: [
        { lat: 45, lon: -105, azimuth_deg: 30, range_km: 150 },
        { lat: 45, lon: -105, azimuth_deg: 10, range_km: null }
      ]
    })
    expect(model.profile).toEqual({ family: 'linear', rate_of_increase: null, formula: null })
    expect(model.hinge).toEqual({ mode: 'origin', distance_km: null })
  })

  it('always sends tilt_factor and the profile (there are no per-vector tilts)', () => {
    const payload = buildProcessPayload(form([vec(), vec({ azimuthDeg: '80' })]))
    expect(payload).not.toHaveProperty('tilt_azimuth')
    expect(payload.tilt_factor).toBe('0.35')
    const model = JSON.parse(payload.tilt_model)
    expect(model.profile).toEqual({ family: 'linear', rate_of_increase: null, formula: null })
    expect(model.hinge.mode).toBe('origin')
  })

  it('a polynomial profile sends its formula; a quadratic only its rate', () => {
    const poly = { profile: { ...DEFAULT_PROFILE, family: 'polynomial', formula: '2e-4 x^2', rateOfIncrease: '1' } }
    expect(tm(form([vec()], {}, poly)).profile).toEqual({
      family: 'polynomial', rate_of_increase: null, formula: '2e-4 x^2'
    })
    const quad = { profile: { ...DEFAULT_PROFILE, family: 'quadratic', rateOfIncrease: '0.004', formula: 'junk' } }
    expect(tm(form([vec()], {}, quad)).profile).toEqual({ family: 'quadratic', rate_of_increase: 0.004, formula: null })
  })

  it('Basic mode never sends tilt_model or reads vectors', () => {
    const basic = { ...form([vec()]), mode: 'basic', tiltAzimuth: '45' }
    const payload = buildProcessPayload(basic)
    expect(payload).not.toHaveProperty('tilt_model')
    expect(payload.tilt_azimuth).toBe('45')
    expect(payload.tilt_factor).toBe('0.35')
  })

  it('Advanced with the azimuth source is unchanged: azimuth, factor and an azimuth model', () => {
    const f = form([vec()], { tiltAzimuth: '45' }, { directionSource: 'azimuth' })
    const payload = buildProcessPayload(f)
    expect(payload.tilt_azimuth).toBe('45')
    expect(JSON.parse(payload.tilt_model).direction).toEqual({ type: 'azimuth' })
  })

  it('a save with no directionSource (older shape) is the azimuth source', () => {
    const { directionSource, vectors, ...old } = advanced([])
    expect(buildTiltModel(old).direction).toEqual({ type: 'azimuth' })
    expect(tiltModelIssues(old)).toEqual([])
  })
})

describe('describeTiltModel in vectors mode', () => {
  it('counts the vectors and names the one profile', () => {
    expect(describeTiltModel(advanced([vec(), vec(), vec()]), null, null)).toBe(
      '3 vectors, linear · hinge at spillway'
    )
    expect(describeTiltModel(advanced([vec()]), null, null)).toBe('1 vector, linear · hinge at spillway')
    const poly = advanced([vec()], { profile: { ...DEFAULT_PROFILE, family: 'polynomial', formula: '2e-4 x^2' } })
    expect(describeTiltModel(poly, null, null)).toBe('1 vector, polynomial, 2e-4 x^2 · hinge at spillway')
  })
})
