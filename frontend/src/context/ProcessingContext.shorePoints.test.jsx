// Shore-point state (spec 6): persistence, older saves, and the transient fit.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'

import { ProcessingProvider, useProcessing } from './ProcessingContext.jsx'
import { newShorePoint } from '../utils/shorePoints.js'

const STORAGE_KEY = 'gia-tool:last-run'
let ctx
function Readout() {
  ctx = useProcessing()
  return null
}
const renderProvider = () =>
  render(
    <ProcessingProvider>
      <Readout />
    </ProcessingProvider>
  )
const saved = () => JSON.parse(window.localStorage.getItem(STORAGE_KEY))

beforeEach(() => window.localStorage.clear())

describe('shore-point state', () => {
  it('defaults: no points, order 2, apply as fitted, warn outside the data', () => {
    renderProvider()
    expect(ctx.formState.advanced.shorePoints).toEqual([])
    expect(ctx.formState.advanced.surface).toEqual({ order: 2, hinge: 'none', extrapolation: 'warn' })
    expect(ctx.formState.surfaceFit).toBeNull()
  })

  it('persists the points and options, but never the fit response', () => {
    renderProvider()
    const points = [newShorePoint({ lat: '45', lon: '-105', elevationM: '300', label: 'A' })]
    act(() => {
      ctx.updateAdvanced({ directionSource: 'points', shorePoints: points, surface: { order: 1, hinge: 'origin', extrapolation: 'mask' } })
      ctx.updateForm({ surfaceFit: { status: 'ready', data: { big: 'response' }, error: null, key: 'k' } })
    })
    const s = saved()
    expect(s.advanced.shorePoints).toEqual(points)
    expect(s.advanced.surface).toEqual({ order: 1, hinge: 'origin', extrapolation: 'mask' })
    expect(s.advanced.directionSource).toBe('points')
    expect('surfaceFit' in s).toBe(false)
  })

  it('carries points forward across a reload, repairing rows without ids or keys', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ mode: 'advanced', advanced: { directionSource: 'points', shorePoints: [{ lat: '45' }, { id: 'keep', lon: '3' }], surface: { order: 3 } } })
    )
    renderProvider()
    const [a, b] = ctx.formState.advanced.shorePoints
    expect(a).toMatchObject({ lat: '45', lon: '', elevationM: '', label: '' })
    expect(a.id).toMatch(/^p_/)
    expect(b.id).toBe('keep')
    expect(ctx.formState.advanced.directionSource).toBe('points')
    expect(ctx.formState.advanced.surface).toEqual({ order: 3, hinge: 'none', extrapolation: 'warn' }) // merged over defaults
  })

  it('an older save with no shore-point keys gets the defaults', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: 'advanced', advanced: { directionSource: 'vectors', vectors: [] } }))
    renderProvider()
    expect(ctx.formState.advanced.shorePoints).toEqual([])
    expect(ctx.formState.advanced.surface).toEqual({ order: 2, hinge: 'none', extrapolation: 'warn' })
  })

  it('switching direction source never clears the points', () => {
    renderProvider()
    act(() => ctx.updateAdvanced({ shorePoints: [newShorePoint({ lat: '1' })] }))
    act(() => ctx.updateAdvanced({ directionSource: 'points' }))
    act(() => ctx.updateAdvanced({ directionSource: 'azimuth' }))
    expect(ctx.formState.advanced.shorePoints).toHaveLength(1)
  })

  it('a localStorage quota failure (a big point table) warns once and leaves in-memory state alone', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    renderProvider()
    const many = Array.from({ length: 50 }, (_, i) => newShorePoint({ lat: String(i) }))
    act(() => ctx.updateAdvanced({ shorePoints: many }))
    act(() => ctx.updateAdvanced({ shorePoints: [...many, newShorePoint()] }))
    expect(ctx.formState.advanced.shorePoints).toHaveLength(51)
    expect(warn).toHaveBeenCalledTimes(1)
    setItem.mockRestore()
    warn.mockRestore()
  })
})
