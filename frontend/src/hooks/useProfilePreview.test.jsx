import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'

import { ProcessingProvider, useProcessing } from '../context/ProcessingContext.jsx'
import { useProfilePreview, PREVIEW_DEBOUNCE_MS } from './useProfilePreview.js'
import { profilePreview } from '../api/client.js'

vi.mock('../api/client.js', () => ({ profilePreview: vi.fn() }))

let ctx
function Harness() {
  ctx = useProcessing()
  useProfilePreview()
  return null
}

const RESPONSE = {
  d_km: [-1, 1], uplift_m: [0, 1], gradient_m_per_km: [0, 1], d_range_km: [-1, 1], hinge_km: 0, warnings: []
}

const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const edit = (patch) => act(() => ctx.updateForm(patch))
const editAdvanced = (patch) => act(() => ctx.updateAdvanced(patch))

beforeEach(() => {
  window.localStorage.clear()
  vi.clearAllMocks()
  vi.useFakeTimers()
  profilePreview.mockResolvedValue(RESPONSE)
  render(
    <ProcessingProvider>
      <Harness />
    </ProcessingProvider>
  )
  edit({ mode: 'advanced', tiltAzimuth: '28', tiltFactor: '0.35' })
})

afterEach(() => vi.useRealTimers())

describe('useProfilePreview', () => {
  it('requests once, debounced, with the tilt inputs in the API shape', async () => {
    await advance(PREVIEW_DEBOUNCE_MS - 50)
    expect(profilePreview).not.toHaveBeenCalled()
    await advance(100)

    expect(profilePreview).toHaveBeenCalledTimes(1)
    expect(profilePreview.mock.calls[0][0]).toEqual({
      tilt_azimuth: 28,
      tilt_factor: 0.35,
      tilt_model: {
        version: 1,
        direction: { type: 'azimuth' },
        profile: { family: 'linear', rate_of_increase: null, second_gradient: null, coefficients: null },
        hinge: { mode: 'origin', distance_km: null }
      },
      origin: null,
      bounds_wgs84: null
    })
    expect(ctx.formState.profilePreview).toEqual({ status: 'ready', data: RESPONSE, error: null })
  })

  it('sends the resolved origin and DEM bounds once known, and refetches when they arrive', async () => {
    await advance(PREVIEW_DEBOUNCE_MS + 10)
    edit({ resolvedOrigin: [-104.9, 44.9], boundsWgs84: [-105, 44, -104, 45] })
    await advance(PREVIEW_DEBOUNCE_MS + 10)

    expect(profilePreview).toHaveBeenCalledTimes(2)
    expect(profilePreview.mock.calls[1][0]).toMatchObject({
      origin: [-104.9, 44.9],
      bounds_wgs84: [-105, 44, -104, 45]
    })
  })

  it('collapses a burst of edits into a single request', async () => {
    await advance(PREVIEW_DEBOUNCE_MS + 10)
    profilePreview.mockClear()

    for (const value of ['0.4', '0.45', '0.5']) {
      edit({ tiltFactor: value })
      await advance(100)
    }
    await advance(PREVIEW_DEBOUNCE_MS)

    expect(profilePreview).toHaveBeenCalledTimes(1)
    expect(profilePreview.mock.calls[0][0].tilt_factor).toBe(0.5)
  })

  it('fires no request while the active curvature input is malformed, and clears the chart', async () => {
    await advance(PREVIEW_DEBOUNCE_MS + 10)
    expect(ctx.formState.profilePreview.status).toBe('ready')
    profilePreview.mockClear()

    editAdvanced({
      profile: { ...ctx.formState.advanced.profile, family: 'quadratic', curvatureInput: 'rate', rateOfIncrease: 'abc' }
    })
    await advance(PREVIEW_DEBOUNCE_MS * 3)
    expect(profilePreview).not.toHaveBeenCalled()
    expect(ctx.formState.profilePreview).toBeNull()

    editAdvanced({ profile: { ...ctx.formState.advanced.profile, rateOfIncrease: '4e-3' } })
    await advance(PREVIEW_DEBOUNCE_MS + 10)
    expect(profilePreview).toHaveBeenCalledTimes(1)
    expect(profilePreview.mock.calls[0][0].tilt_model.profile).toEqual({
      family: 'quadratic', rate_of_increase: 0.004, second_gradient: null, coefficients: null
    })
  })

  it('sends a second gradient (and no rate) while that form is active', async () => {
    editAdvanced({
      profile: {
        ...ctx.formState.advanced.profile,
        family: 'quadratic',
        curvatureInput: 'secondGradient',
        secondGradient: '1.2',
        secondGradientDistanceKm: '150'
      }
    })
    await advance(PREVIEW_DEBOUNCE_MS + 10)
    expect(profilePreview.mock.calls.at(-1)[0].tilt_model.profile).toEqual({
      family: 'quadratic',
      rate_of_increase: null,
      second_gradient: { gradient_m_per_km: 1.2, distance_km: 150 },
      coefficients: null
    })
  })

  it('fires nothing in Basic mode', async () => {
    edit({ mode: 'basic' })
    await advance(PREVIEW_DEBOUNCE_MS * 3)
    expect(profilePreview).not.toHaveBeenCalled()
    expect(ctx.formState.profilePreview).toBeNull()
  })

  it('fires nothing until azimuth and gradient are filled in', async () => {
    edit({ tiltAzimuth: '' })
    await advance(PREVIEW_DEBOUNCE_MS * 3)
    expect(profilePreview).not.toHaveBeenCalled()
  })

  it('ignores a stale response when newer inputs were requested', async () => {
    let resolveFirst
    const first = new Promise((resolve) => (resolveFirst = resolve))
    const second = { ...RESPONSE, hinge_km: -42 }
    profilePreview.mockReturnValueOnce(first).mockResolvedValueOnce(second)

    await advance(PREVIEW_DEBOUNCE_MS + 10) // request 1 in flight
    edit({ tiltFactor: '0.5' })
    await advance(PREVIEW_DEBOUNCE_MS + 10) // request 2 lands
    expect(ctx.formState.profilePreview.data).toEqual(second)

    await act(async () => resolveFirst({ ...RESPONSE, hinge_km: 999 })) // late
    expect(ctx.formState.profilePreview.data).toEqual(second)
  })

  it('surfaces a server error message and drops the old curve', async () => {
    profilePreview.mockRejectedValueOnce(new Error('A quadratic profile requires a finite rate_of_increase.'))
    await advance(PREVIEW_DEBOUNCE_MS + 10)
    expect(ctx.formState.profilePreview).toEqual({
      status: 'error',
      data: null,
      error: 'A quadratic profile requires a finite rate_of_increase.'
    })
  })

  it('keeps the previous curve on screen (status loading) while a refresh is in flight', async () => {
    await advance(PREVIEW_DEBOUNCE_MS + 10)
    profilePreview.mockReturnValueOnce(new Promise(() => {}))
    edit({ tiltFactor: '0.6' })
    await advance(PREVIEW_DEBOUNCE_MS + 10)
    expect(ctx.formState.profilePreview.status).toBe('loading')
    expect(ctx.formState.profilePreview.data).toEqual(RESPONSE)
  })
})
