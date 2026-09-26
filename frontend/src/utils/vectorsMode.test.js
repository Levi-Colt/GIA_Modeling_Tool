// Vectors direction source (spec 5): readiness, payload and description rules.
import { describe, it, expect } from 'vitest'
import { getReadiness } from './readiness.js'
import { buildProcessPayload } from './payload.js'
import { DEFAULT_HINGE, DEFAULT_PROFILE, buildTiltModel, describeTiltModel, tiltModelIssues } from './tiltModel.js'
import { newVector } from './vectors.js'

const global = (patch = {}) => newVector({ lat: '45', lon: '-105', azimuthDeg: '30', ...patch })
const custom = (patch = {}) =>
  newVector({ lat: '46', lon: '-104', azimuthDeg: '40', tilt: 'custom', custom: { localGradient: '0.6' }, ...patch })

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
    originMode: 'decimal_degrees',
    originValue: '45, -105',
    originEpsg: '',
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
    const r = getReadiness(form([global()]))
    expect(r.ready).toBe(true)
    expect(r.missingText).not.toContain('tilt azimuth')
  })

  it('needs at least one vector, keyed to the tilt section', () => {
    const r = getReadiness(form([]))
    expect(r.ready).toBe(false)
    expect(r.missing).toContainEqual({ section: 'tilt', text: 'at least one vector' })
  })

  it('needs the gradient at the spillway only while some vector is global', () => {
    expect(getReadiness(form([global()], { tiltFactor: '' })).missing).toContainEqual({
      section: 'tilt',
      text: 'the global gradient at the spillway'
    })
    expect(getReadiness(form([global(), custom()], { tiltFactor: '' })).ready).toBe(false)
    expect(getReadiness(form([custom(), custom()], { tiltFactor: '' })).ready).toBe(true)
  })

  it('reports invalid rows and incomplete custom rows in the tilt section', () => {
    const r = getReadiness(form([global({ azimuthDeg: '' }), custom({ custom: { localGradient: '' } })]))
    const tilt = r.missing.filter((m) => m.section === 'tilt').map((m) => m.text)
    expect(tilt).toEqual([
      'a valid latitude, longitude and azimuth for vector 1',
      'a complete custom tilt for vector 2'
    ])
  })

  it('the global profile fields count only while some vector is global', () => {
    const quadratic = { profile: { ...DEFAULT_PROFILE, family: 'quadratic' } } // second gradient form, empty
    expect(getReadiness(form([global()], {}, quadratic)).missingText).toContain('a second gradient (a number)')
    expect(getReadiness(form([custom()], {}, quadratic)).ready).toBe(true) // unused, so not required
  })

  it('the hinge distance is required even when every vector is custom (the hinge always applies)', () => {
    const r = getReadiness(form([custom()], {}, { hinge: { mode: 'distance', distanceKm: '' } }))
    expect(r.missingText).toContain('a hinge distance greater than 0')
  })

  it('still needs the DEM, origin and target elevation, like every mode', () => {
    const r = getReadiness(form([global()], { preflightStatus: 'idle', originValue: '' }))
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
    const f = form([global({ rangeKm: '150' }), global({ azimuthDeg: '10', rangeKm: '' })], { tiltAzimuth: '99' })
    const payload = buildProcessPayload(f)
    expect(payload).not.toHaveProperty('tilt_azimuth') // even if a stale value is in state
    expect(payload.tilt_factor).toBe('0.35')
    const model = JSON.parse(payload.tilt_model)
    expect(model.direction).toEqual({
      type: 'vectors',
      vectors: [
        { lat: 45, lon: -105, azimuth_deg: 30, range_km: 150, custom: null },
        { lat: 45, lon: -105, azimuth_deg: 10, range_km: null, custom: null }
      ]
    })
    expect(model.profile).toEqual({ family: 'linear', rate_of_increase: null, second_gradient: null, coefficients: null })
    expect(model.hinge).toEqual({ mode: 'origin', distance_km: null })
  })

  it('omits tilt_factor (and the unused profile) only when every vector is custom', () => {
    const allCustom = buildProcessPayload(form([custom(), custom()]))
    expect(allCustom).not.toHaveProperty('tilt_factor')
    expect(allCustom).not.toHaveProperty('tilt_azimuth')
    const model = JSON.parse(allCustom.tilt_model)
    expect(model).not.toHaveProperty('profile')
    expect(model.hinge.mode).toBe('origin') // the hinge is still sent

    const mixed = buildProcessPayload(form([custom(), global()]))
    expect(mixed.tilt_factor).toBe('0.35')
    expect(JSON.parse(mixed.tilt_model)).toHaveProperty('profile')
  })

  it('the global profile keeps its active curvature form only', () => {
    const quad = { profile: { ...DEFAULT_PROFILE, family: 'quadratic', rateOfIncrease: '0.004', curvatureInput: 'rate',
      secondGradient: '1', secondGradientDistanceKm: '50' } }
    const profile = tm(form([global()], {}, quad)).profile
    expect(profile.rate_of_increase).toBe(0.004)
    expect(profile.second_gradient).toBeNull()
  })

  it('Basic mode never sends tilt_model or reads vectors', () => {
    const basic = { ...form([global()]), mode: 'basic', tiltAzimuth: '45' }
    const payload = buildProcessPayload(basic)
    expect(payload).not.toHaveProperty('tilt_model')
    expect(payload.tilt_azimuth).toBe('45')
    expect(payload.tilt_factor).toBe('0.35')
  })

  it('Advanced with the azimuth source is unchanged: azimuth, factor and an azimuth model', () => {
    const f = form([global()], { tiltAzimuth: '45' }, { directionSource: 'azimuth' })
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
  it('counts vectors and custom tilts, naming the global profile only when it is used', () => {
    expect(describeTiltModel(advanced([global(), custom(), custom()]), null, null)).toBe(
      '3 vectors (2 custom), global linear · hinge at spillway'
    )
    expect(describeTiltModel(advanced([custom()]), null, null)).toBe('1 vector (1 custom) · hinge at spillway')
    expect(describeTiltModel(advanced([global()]), null, null)).toBe('1 vector, global linear · hinge at spillway')
  })
})
