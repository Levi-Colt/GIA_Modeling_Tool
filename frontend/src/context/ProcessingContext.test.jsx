import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'

import { ProcessingProvider, useProcessing } from './ProcessingContext.jsx'

const STORAGE_KEY = 'gia-tool:last-run'

// Exposes the context's live value to the test body.
let ctx
function Probe() {
  ctx = useProcessing()
  return <div data-testid="mode">{ctx.formState.mode}</div>
}

function mount() {
  return render(
    <ProcessingProvider>
      <Probe />
    </ProcessingProvider>
  )
}

beforeEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
  ctx = null
})

describe('mode switching', () => {
  it('basic -> advanced -> basic leaves every other field deep-equal', () => {
    mount()
    act(() => {
      ctx.updateForm({ tiltAzimuth: '45', tiltFactor: '0.5', originValue: '40,-105', selectionRadiusKm: '12' })
      ctx.updateAdvanced({ sectionsOpen: { dem: false, origin: true, tilt: true, output: true }, extra: [1, 2] })
    })
    const { mode, ...before } = structuredClone({ ...ctx.formState, rasterPreviewGeoraster: null })

    act(() => ctx.updateForm({ mode: 'advanced' }))
    expect(ctx.formState.mode).toBe('advanced')
    act(() => ctx.updateForm({ mode: 'basic' }))

    const { mode: after, ...rest } = structuredClone({ ...ctx.formState, rasterPreviewGeoraster: null })
    expect(after).toBe('basic')
    expect(rest).toEqual(before)
  })
})

describe('persistence', () => {
  it('restores mode and advanced after a remount (simulated reload)', () => {
    const first = mount()
    act(() => {
      ctx.updateForm({ mode: 'advanced', tiltAzimuth: '90' })
      ctx.updateAdvanced({ sectionsOpen: { dem: false, origin: false, tilt: true, output: true } })
    })
    first.unmount()

    mount()
    expect(screen.getByTestId('mode')).toHaveTextContent('advanced')
    expect(ctx.formState.tiltAzimuth).toBe('90')
    expect(ctx.formState.advanced.sectionsOpen).toEqual({ dem: false, origin: false, tilt: true, output: true })
  })

  it('never persists transient status fields', () => {
    mount()
    act(() => ctx.updateForm({ preflightStatus: 'valid', elevationCheckStatus: 'dem', tiltAzimuth: '1' }))
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY))
    expect(saved).not.toHaveProperty('preflightStatus')
    expect(saved).not.toHaveProperty('elevationCheckStatus')
    expect(saved.tiltAzimuth).toBe('1')
  })

  it('loads a legacy blob without mode/advanced with defaults and keeps saved fields', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ tiltAzimuth: '30', originValue: '1,2', includeDem: false }))
    mount()
    expect(ctx.formState.mode).toBe('basic')
    expect(ctx.formState.advanced.sectionsOpen).toEqual({ dem: true, origin: true, tilt: true, output: false })
    expect(ctx.formState.tiltAzimuth).toBe('30')
    expect(ctx.formState.originValue).toBe('1,2')
    expect(ctx.formState.includeDem).toBe(false)
  })

  it('fills missing keys of a partial saved advanced object from defaults', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ mode: 'advanced', advanced: { sectionsOpen: { dem: false }, futureKey: 'kept' } })
    )
    mount()
    expect(ctx.formState.mode).toBe('advanced')
    expect(ctx.formState.advanced.sectionsOpen).toEqual({ dem: false, origin: true, tilt: true, output: false })
    expect(ctx.formState.advanced.futureKey).toBe('kept')
  })

  it('falls back to defaults when the saved advanced value is corrupt', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ advanced: null }))
    mount()
    expect(ctx.formState.advanced.sectionsOpen.dem).toBe(true)
  })

  it('does not throw out of updateForm when localStorage.setItem throws, and still updates state', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mount()

    expect(() => act(() => ctx.updateForm({ tiltAzimuth: '10' }))).not.toThrow()
    expect(() => act(() => ctx.updateAdvanced({ x: 1 }))).not.toThrow()
    expect(ctx.formState.tiltAzimuth).toBe('10')
    expect(ctx.formState.advanced.x).toBe(1)
    expect(setItem).toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1) // once, not per write
  })
})

describe('updateAdvanced', () => {
  it('merges into advanced without touching top-level fields', () => {
    mount()
    act(() => ctx.updateForm({ tiltAzimuth: '5' }))
    act(() => ctx.updateAdvanced({ foo: 'bar' }))
    expect(ctx.formState.advanced.foo).toBe('bar')
    expect(ctx.formState.advanced.sectionsOpen).toBeDefined()
    expect(ctx.formState.tiltAzimuth).toBe('5')
  })
})
