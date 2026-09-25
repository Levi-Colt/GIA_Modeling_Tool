import { describe, it, expect } from 'vitest'
import { BASEMAPS, pickBasemapKey } from './basemap.js'

describe('pickBasemapKey', () => {
  it('picks USGS Topo for a Colorado extent', () => {
    expect(pickBasemapKey([-106, 39, -104, 41])).toBe('usgs_topo')
  })

  it('picks NRCan for a Manitoba (Lake Agassiz) extent', () => {
    expect(pickBasemapKey([-100, 50, -97, 53])).toBe('nrcan_cbmt')
  })

  it('picks NRCan for a Quebec extent', () => {
    expect(pickBasemapKey([-73, 46, -70, 48])).toBe('nrcan_cbmt')
  })

  it('picks USGS Topo for an Alaska extent', () => {
    expect(pickBasemapKey([-150.5, 61, -149, 62])).toBe('usgs_topo')
  })

  it('picks USGS Topo for a Hawaii extent', () => {
    expect(pickBasemapKey([-158, 21, -157.5, 21.6])).toBe('usgs_topo')
  })

  it('returns a valid key for missing or malformed extents without throwing', () => {
    for (const bad of [null, undefined, [], [1, 2, 3], [NaN, 0, 0, 0]]) {
      expect(Object.keys(BASEMAPS)).toContain(pickBasemapKey(bad))
    }
  })
})
