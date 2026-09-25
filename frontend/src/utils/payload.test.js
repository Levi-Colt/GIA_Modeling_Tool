import { describe, it, expect } from 'vitest'
import { buildProcessPayload } from './payload.js'
import { DEFAULT_HINGE, DEFAULT_PROFILE } from './tiltModel.js'

const profile = DEFAULT_PROFILE
const hinge = DEFAULT_HINGE

// The parsed tilt_model an Advanced run would send for these advanced fields.
function tiltModel(advanced) {
  return JSON.parse(buildProcessPayload({ ...form, mode: 'advanced', advanced }).tilt_model)
}

const form = {
  demFile: null,
  demPath: '/data/dem.tif',
  originMode: 'decimal_degrees',
  originValue: '40, -105',
  originEpsg: '',
  tiltAzimuth: '45',
  tiltFactor: '0.5',
  targetElevation: '1500',
  includeDem: true,
  selectionRadiusKm: ''
}

describe('buildProcessPayload', () => {
  it('omits selection_radius_km when the radius is empty', () => {
    expect(buildProcessPayload(form)).not.toHaveProperty('selection_radius_km')
    const { selectionRadiusKm, ...withoutField } = form
    expect(buildProcessPayload(withoutField)).not.toHaveProperty('selection_radius_km')
  })

  it('includes selection_radius_km when the radius is set', () => {
    expect(buildProcessPayload({ ...form, selectionRadiusKm: '12.5' })).toMatchObject({
      selection_radius_km: '12.5'
    })
  })

  it('ignores formState.advanced entirely in Basic mode', () => {
    const clean = buildProcessPayload({ ...form, mode: 'basic' })
    const withAdvanced = buildProcessPayload({
      ...form,
      mode: 'basic',
      advanced: { sectionsOpen: { dem: false }, anything: [1, 2, 3] }
    })
    expect(withAdvanced).toEqual(clean)
  })

  it('never sends tilt_model in Basic mode, whatever advanced holds', () => {
    const advanced = { profile: { ...profile, family: 'quadratic', rateOfIncrease: '0.5' } }
    expect(buildProcessPayload({ ...form, mode: 'basic', advanced })).not.toHaveProperty('tilt_model')
    expect(buildProcessPayload({ ...form, mode: 'basic' })).not.toHaveProperty('tilt_model')
  })

  it('Advanced sends the same shared fields as Basic, plus tilt_model', () => {
    const { tilt_model, ...shared } = buildProcessPayload({ ...form, mode: 'advanced', advanced: {} })
    expect(shared).toEqual(buildProcessPayload({ ...form, mode: 'basic' }))
    expect(typeof tilt_model).toBe('string')
  })

  it('keeps the existing fields', () => {
    expect(buildProcessPayload(form)).toMatchObject({
      file_path: '/data/dem.tif',
      origin_mode: 'decimal_degrees',
      include_dem: true
    })
  })
})

describe('tilt_model (Advanced)', () => {
  it('linear + the default hinge sends an explicit origin hinge', () => {
    expect(tiltModel({ profile, hinge })).toEqual({
      version: 1,
      direction: { type: 'azimuth' },
      profile: { family: 'linear', rate_of_increase: null, second_gradient: null, coefficients: null },
      hinge: { mode: 'origin', distance_km: null }
    })
  })

  it('the hinge defaults to origin for every family', () => {
    const quad = { ...profile, family: 'quadratic', secondGradient: '1.2', secondGradientDistanceKm: '150' }
    const poly = { ...profile, family: 'polynomial', coefficients: ['0.002', '', '', ''], degree: 2 }
    for (const p of [profile, quad, poly]) expect(tiltModel({ profile: p, hinge }).hinge.mode).toBe('origin')
  })

  it("never sends 'default' or 'natural', even from a stale stored value", () => {
    for (const mode of ['default', 'natural']) {
      const body = buildProcessPayload({
        ...form,
        mode: 'advanced',
        advanced: { profile: { ...profile, family: 'quadratic', curvatureInput: 'rate', rateOfIncrease: '1' }, hinge: { mode, distanceKm: '' } }
      }).tilt_model
      expect(JSON.parse(body).hinge).toEqual({ mode: 'origin', distance_km: null })
      expect(body).not.toMatch(/default|natural/)
    }
  })

  it('a quadratic by rate sends only the rate', () => {
    const model = tiltModel({
      profile: {
        ...profile, family: 'quadratic', curvatureInput: 'rate', rateOfIncrease: '4e-3',
        secondGradient: '1.2', secondGradientDistanceKm: '150'
      },
      hinge
    })
    expect(model.profile).toEqual({
      family: 'quadratic', rate_of_increase: 0.004, second_gradient: null, coefficients: null
    })
  })

  it('a quadratic by second gradient sends only the second gradient', () => {
    const model = tiltModel({
      profile: {
        ...profile, family: 'quadratic', curvatureInput: 'secondGradient', rateOfIncrease: '4e-3',
        secondGradient: '1.2', secondGradientDistanceKm: '150'
      },
      hinge
    })
    expect(model.profile).toEqual({
      family: 'quadratic',
      rate_of_increase: null,
      second_gradient: { gradient_m_per_km: 1.2, distance_km: 150 },
      coefficients: null
    })
  })

  it.each([
    [2, [0.1]],
    [3, [0.1, 0.2]],
    [4, [0.1, 0.2, 0.3]],
    [5, [0.1, 0.2, 0.3, 0.4]]
  ])('polynomial degree %i sends only c2..cN, as numbers', (degree, expected) => {
    const model = tiltModel({
      profile: { ...profile, family: 'polynomial', degree, coefficients: ['0.1', '0.2', '0.3', '0.4'] },
      hinge
    })
    expect(model.profile.coefficients).toEqual(expected)
    expect(model.profile.rate_of_increase).toBeNull()
    expect(model.profile.second_gradient).toBeNull()
  })

  it('ignores values typed into hidden coefficient slots and other families', () => {
    const model = tiltModel({
      profile: {
        ...profile, family: 'polynomial', degree: 2, coefficients: ['0.1', 'junk', 'junk', 'junk'],
        rateOfIncrease: 'abc', secondGradient: 'abc'
      },
      hinge
    })
    expect(model.profile).toEqual({
      family: 'polynomial', rate_of_increase: null, second_gradient: null, coefficients: [0.1]
    })
  })

  it('sends a distance hinge with its km, and no km for other modes', () => {
    expect(tiltModel({ profile, hinge: { mode: 'distance', distanceKm: '30' } }).hinge).toEqual({
      mode: 'distance',
      distance_km: 30
    })
    expect(tiltModel({ profile, hinge: { mode: 'none', distanceKm: '30' } }).hinge).toEqual({
      mode: 'none',
      distance_km: null
    })
    expect(tiltModel({ profile, hinge: { mode: 'origin', distanceKm: '30' } }).hinge.distance_km).toBeNull()
  })

  it('falls back to defaults when advanced has no profile/hinge', () => {
    expect(tiltModel({ sectionsOpen: {} }).profile.family).toBe('linear')
    expect(tiltModel({ sectionsOpen: {} }).hinge.mode).toBe('origin')
  })
})
