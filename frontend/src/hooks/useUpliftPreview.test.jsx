import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'

import { ProcessingProvider, useProcessing } from '../context/ProcessingContext.jsx'
import { useUpliftPreview, UPLIFT_PREVIEW_DEBOUNCE_MS } from './useUpliftPreview.js'
import { useProfilePreview } from './useProfilePreview.js'
import { upliftPreview, profilePreview } from '../api/client.js'
import { newVector } from '../utils/vectors.js'

vi.mock('../api/client.js', () => ({ upliftPreview: vi.fn(), profilePreview: vi.fn() }))

let ctx
function Harness() {
  ctx = useProcessing()
  useUpliftPreview()
  useProfilePreview()
  return null
}

const RESPONSE = {
  isobases: { type: 'FeatureCollection', features: [] },
  interval_m: 10,
  vectors: [{ index: 0, misfit_deg: 1 }],
  misfit_rms_deg: 1, misfit_max_deg: 1, worst_vector: 0, hinge_km: 0, hinge_source: 'mode', warnings: []
}

const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const edit = (patch) => act(() => ctx.updateForm(patch))
const A = newVector({ lat: '45', lon: '-105', azimuthDeg: '30' })
const C = newVector({ lat: '46', lon: '-104', azimuthDeg: '40', tilt: 'custom', custom: { localGradient: '0.6' } })

function ready(vectors = [A]) {
  act(() => {
    ctx.updateForm({
      mode: 'advanced', tiltFactor: '0.35', resolvedOrigin: [-104.9, 44.9], boundsWgs84: [-105, 44, -104, 45]
    })
    ctx.updateAdvanced({ directionSource: 'vectors' })
    ctx.setVectors(vectors)
  })
}

beforeEach(() => {
  window.localStorage.clear()
  vi.clearAllMocks()
  vi.useFakeTimers()
  upliftPreview.mockResolvedValue(RESPONSE)
  profilePreview.mockResolvedValue({})
  render(
    <ProcessingProvider>
      <Harness />
    </ProcessingProvider>
  )
})

afterEach(() => vi.useRealTimers())

describe('useUpliftPreview', () => {
  it('requests once, debounced, with the vectors model and the origin and bounds the endpoint requires', async () => {
    ready()
    await advance(UPLIFT_PREVIEW_DEBOUNCE_MS - 50)
    expect(upliftPreview).not.toHaveBeenCalled()
    await advance(100)

    expect(upliftPreview).toHaveBeenCalledTimes(1)
    expect(upliftPreview.mock.calls[0][0]).toEqual({
      tilt_factor: 0.35,
      tilt_model: {
        version: 1,
        direction: { type: 'vectors', vectors: [{ lat: 45, lon: -105, azimuth_deg: 30, range_km: null, custom: null }] },
        profile: { family: 'linear', rate_of_increase: null, second_gradient: null, coefficients: null },
        hinge: { mode: 'origin', distance_km: null }
      },
      origin: [-104.9, 44.9],
      bounds_wgs84: [-105, 44, -104, 45]
    })
    expect(ctx.formState.upliftPreview).toEqual({ status: 'ready', data: RESPONSE, error: null })
  })

  it('never calls the azimuth profile preview in vectors mode, and vice versa', async () => {
    ready()
    await advance(UPLIFT_PREVIEW_DEBOUNCE_MS + 600)
    expect(profilePreview).not.toHaveBeenCalled()

    act(() => ctx.updateAdvanced({ directionSource: 'azimuth' }))
    edit({ tiltAzimuth: '28' })
    await advance(UPLIFT_PREVIEW_DEBOUNCE_MS + 600)
    expect(profilePreview).toHaveBeenCalled()
    expect(upliftPreview).toHaveBeenCalledTimes(1) // the earlier one only
  })

  it('omits tilt_factor and the profile when every vector is custom', async () => {
    ready([C])
    await advance(UPLIFT_PREVIEW_DEBOUNCE_MS + 10)
    const body = upliftPreview.mock.calls[0][0]
    expect(body).not.toHaveProperty('tilt_factor')
    expect(body.tilt_model).not.toHaveProperty('profile')
    expect(body.tilt_model.direction.vectors[0].custom).toEqual({ family: 'linear', local_gradient: 0.6 })
  })

  it('waits for the resolved origin and DEM bounds', async () => {
    ready()
    edit({ resolvedOrigin: null })
    await advance(UPLIFT_PREVIEW_DEBOUNCE_MS + 10)
    expect(upliftPreview).not.toHaveBeenCalled()

    edit({ resolvedOrigin: [-104.9, 44.9], boundsWgs84: null })
    await advance(UPLIFT_PREVIEW_DEBOUNCE_MS + 10)
    expect(upliftPreview).not.toHaveBeenCalled()

    edit({ boundsWgs84: [-105, 44, -104, 45] })
    await advance(UPLIFT_PREVIEW_DEBOUNCE_MS + 10)
    expect(upliftPreview).toHaveBeenCalledTimes(1)
  })

  it('does not fire for incomplete vectors, and clears a stale preview when they become invalid', async () => {
    ready([newVector({ lat: '45', lon: '-105' })]) // no azimuth yet
    await advance(UPLIFT_PREVIEW_DEBOUNCE_MS + 10)
    expect(upliftPreview).not.toHaveBeenCalled()

    act(() => ctx.setVectors([A]))
    await advance(UPLIFT_PREVIEW_DEBOUNCE_MS + 10)
    expect(ctx.formState.upliftPreview?.status).toBe('ready')

    act(() => ctx.setVectors([{ ...A, azimuthDeg: '' }]))
    await advance(10)
    expect(ctx.formState.upliftPreview).toBeNull() // stale isobases must not linger
  })

  it('debounces a burst of edits into one request, with the latest values', async () => {
    ready()
    await advance(UPLIFT_PREVIEW_DEBOUNCE_MS + 10)
    upliftPreview.mockClear()

    for (const az of ['31', '32', '33']) {
      act(() => ctx.setVectors((l) => l.map((v) => ({ ...v, azimuthDeg: az }))))
      await advance(100)
    }
    await advance(UPLIFT_PREVIEW_DEBOUNCE_MS)
    expect(upliftPreview).toHaveBeenCalledTimes(1)
    expect(upliftPreview.mock.calls[0][0].tilt_model.direction.vectors[0].azimuth_deg).toBe(33)
  })

  it('drops a stale response when newer inputs were requested', async () => {
    let resolveFirst
    upliftPreview
      .mockImplementationOnce(() => new Promise((res) => { resolveFirst = res }))
      .mockResolvedValueOnce({ ...RESPONSE, interval_m: 99 })
    ready()
    await advance(UPLIFT_PREVIEW_DEBOUNCE_MS + 10) // first request in flight

    act(() => ctx.setVectors((l) => l.map((v) => ({ ...v, azimuthDeg: '75' }))))
    await advance(UPLIFT_PREVIEW_DEBOUNCE_MS + 10)
    expect(ctx.formState.upliftPreview.data.interval_m).toBe(99)

    await act(async () => resolveFirst({ ...RESPONSE, interval_m: 1 })) // late, stale
    expect(ctx.formState.upliftPreview.data.interval_m).toBe(99)
  })

  it('shows the error message from a failed request', async () => {
    upliftPreview.mockRejectedValue(new Error('Vector 1: lat must be between -90 and 90.'))
    ready()
    await advance(UPLIFT_PREVIEW_DEBOUNCE_MS + 10)
    expect(ctx.formState.upliftPreview).toEqual({
      status: 'error', data: null, error: 'Vector 1: lat must be between -90 and 90.'
    })
  })

  it('is inert in Basic mode', async () => {
    ready()
    edit({ mode: 'basic' })
    await advance(UPLIFT_PREVIEW_DEBOUNCE_MS + 10)
    expect(ctx.formState.upliftPreview).toBeNull()
  })
})
