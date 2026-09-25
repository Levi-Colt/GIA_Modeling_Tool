import { describe, it, expect } from 'vitest'
import { buildProcessPayload } from './payload.js'

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

  it('keeps the existing fields', () => {
    expect(buildProcessPayload(form)).toMatchObject({
      file_path: '/data/dem.tif',
      origin_mode: 'decimal_degrees',
      include_dem: true
    })
  })
})
