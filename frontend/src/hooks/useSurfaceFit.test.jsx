import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'

import { ProcessingProvider, useProcessing } from '../context/ProcessingContext.jsx'
import { useSurfaceFit, surfaceFitKey, SURFACE_FIT_DEBOUNCE_MS } from './useSurfaceFit.js'
import { useProfilePreview } from './useProfilePreview.js'
import { useUpliftPreview } from './useUpliftPreview.js'
import { fitUpliftSurface, profilePreview, upliftPreview } from '../api/client.js'
import { newShorePoint } from '../utils/shorePoints.js'

vi.mock('../api/client.js', () => ({
  fitUpliftSurface: vi.fn(),
  profilePreview: vi.fn(),
  upliftPreview: vi.fn()
}))

let ctx
function Harness() {
  ctx = useProcessing()
  useSurfaceFit()
  useProfilePreview()
  useUpliftPreview()
  return null
}

const RESPONSE = {
  orders: [{ order: 1, n: 9, terms: 3, r2: 0.9, adj_r2: 0.88, rmse_m: 3 }],
  selected: { order: 2, n: 9, terms: 6, r2: 0.99, adj_r2: 0.98, rmse_m: 1, cond: 5, residuals_m: [], std_residuals: [], outlier_indices: [] },
  isobases: { inside: { type: 'FeatureCollection', features: [] }, outside: { type: 'FeatureCollection', features: [] } },
  interval_m: 10,
  hull: { type: 'Polygon', coordinates: [[]] },
  dem_fraction_outside_hull: 0,
  origin_inside_hull: true,
  warnings: []
}

const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const edit = (patch) => act(() => ctx.updateForm(patch))
const pts = (n) =>
  Array.from({ length: n }, (_, i) =>
    newShorePoint({ lat: String(45 + i / 50), lon: String(-105 + i / 50), elevationM: String(300 + i), label: i === 0 ? 'Pit 7' : '' })
  )

function ready(n = 9, surface = { order: 2, hinge: 'none', extrapolation: 'warn' }) {
  act(() => {
    ctx.updateForm({ mode: 'advanced', resolvedOrigin: [-104.9, 44.9], boundsWgs84: [-105, 44, -104, 45] })
    ctx.updateAdvanced({ directionSource: 'points', shorePoints: pts(n), surface })
  })
}

beforeEach(() => {
  window.localStorage.clear()
  vi.clearAllMocks()
  vi.useFakeTimers()
  fitUpliftSurface.mockResolvedValue(RESPONSE)
  profilePreview.mockResolvedValue({})
  upliftPreview.mockResolvedValue({})
  render(
    <ProcessingProvider>
      <Harness />
    </ProcessingProvider>
  )
})

afterEach(() => vi.useRealTimers())

describe('useSurfaceFit', () => {
  it('requests once, debounced, with the points, options, origin and bounds', async () => {
    ready()
    await advance(SURFACE_FIT_DEBOUNCE_MS - 50)
    expect(fitUpliftSurface).not.toHaveBeenCalled()
    await advance(100)

    expect(fitUpliftSurface).toHaveBeenCalledTimes(1)
    const body = fitUpliftSurface.mock.calls[0][0]
    expect(Object.keys(body).sort()).toEqual(['bounds_wgs84', 'extrapolation', 'hinge', 'order', 'origin', 'points'])
    expect(body).toMatchObject({
      order: 2, hinge: 'none', extrapolation: 'warn', origin: [-104.9, 44.9], bounds_wgs84: [-105, 44, -104, 45]
    })
    expect(body.points).toHaveLength(9)
    expect(body.points[0]).toEqual({ lat: 45, lon: -105, elevation_m: 300, label: 'Pit 7' })
    expect('label' in body.points[1]).toBe(false)
  })

  it('stores the answer with the key of the request it answers, and shows a loading state before', async () => {
    ready()
    await advance(SURFACE_FIT_DEBOUNCE_MS + 1)
    expect(ctx.formState.surfaceFit).toEqual({ status: 'ready', data: RESPONSE, error: null, key: surfaceFitKey(ctx.formState) })

    act(() => ctx.updateAdvanced({ surface: { order: 1, hinge: 'none', extrapolation: 'warn' } }))
    expect(ctx.formState.surfaceFit.key).not.toBe(surfaceFitKey(ctx.formState)) // now stale
    await advance(SURFACE_FIT_DEBOUNCE_MS + 1)
    expect(ctx.formState.surfaceFit.key).toBe(surfaceFitKey(ctx.formState))
  })

  it('re-requests when the order, either option, the origin or the bounds change', async () => {
    ready()
    await advance(SURFACE_FIT_DEBOUNCE_MS + 10)
    fitUpliftSurface.mockClear()

    const steps = [
      () => ctx.updateAdvanced({ surface: { order: 1, hinge: 'none', extrapolation: 'warn' } }),
      () => ctx.updateAdvanced({ surface: { order: 1, hinge: 'origin', extrapolation: 'warn' } }),
      () => ctx.updateAdvanced({ surface: { order: 1, hinge: 'origin', extrapolation: 'mask' } }),
      () => ctx.updateForm({ resolvedOrigin: [-104.8, 44.9] }),
      () => ctx.updateForm({ boundsWgs84: [-105, 44, -103, 45] })
    ]
    for (const step of steps) {
      act(step)
      await advance(SURFACE_FIT_DEBOUNCE_MS + 10)
    }
    expect(fitUpliftSurface).toHaveBeenCalledTimes(steps.length)
  })

  it('waits for the resolved origin and DEM bounds', async () => {
    ready()
    edit({ resolvedOrigin: null })
    await advance(SURFACE_FIT_DEBOUNCE_MS + 10)
    expect(fitUpliftSurface).not.toHaveBeenCalled()

    edit({ resolvedOrigin: [-104.9, 44.9], boundsWgs84: null })
    await advance(SURFACE_FIT_DEBOUNCE_MS + 10)
    expect(fitUpliftSurface).not.toHaveBeenCalled()

    edit({ boundsWgs84: [-105, 44, -104, 45] })
    await advance(SURFACE_FIT_DEBOUNCE_MS + 10)
    expect(fitUpliftSurface).toHaveBeenCalledTimes(1)
  })

  it('does not fire below the minimum for the order or for an invalid row, and clears a stale fit', async () => {
    ready(8) // order 2 needs 9
    await advance(SURFACE_FIT_DEBOUNCE_MS + 10)
    expect(fitUpliftSurface).not.toHaveBeenCalled()

    act(() => ctx.updateAdvanced({ shorePoints: pts(9) }))
    await advance(SURFACE_FIT_DEBOUNCE_MS + 10)
    expect(ctx.formState.surfaceFit?.status).toBe('ready')

    const bad = pts(9)
    bad[2] = { ...bad[2], lat: '' }
    act(() => ctx.updateAdvanced({ shorePoints: bad }))
    await advance(10)
    expect(ctx.formState.surfaceFit).toBeNull() // stale isobases must not linger
  })

  it('clears the fit when the direction source is not points, and never calls the other previews', async () => {
    ready()
    await advance(SURFACE_FIT_DEBOUNCE_MS + 600)
    expect(ctx.formState.surfaceFit?.status).toBe('ready')
    expect(profilePreview).not.toHaveBeenCalled()
    expect(upliftPreview).not.toHaveBeenCalled()

    act(() => ctx.updateAdvanced({ directionSource: 'azimuth' }))
    await advance(10)
    expect(ctx.formState.surfaceFit).toBeNull()
    fitUpliftSurface.mockClear()
    edit({ tiltAzimuth: '28', tiltFactor: '0.3' })
    await advance(SURFACE_FIT_DEBOUNCE_MS + 600)
    expect(fitUpliftSurface).not.toHaveBeenCalled()
  })

  it('debounces a burst of edits into one request, with the latest values', async () => {
    ready()
    await advance(SURFACE_FIT_DEBOUNCE_MS + 10)
    fitUpliftSurface.mockClear()

    for (const z of ['400', '401', '402']) {
      act(() => ctx.updateAdvanced({ shorePoints: pts(9).map((p, i) => (i === 3 ? { ...p, elevationM: z } : p)) }))
      await advance(100)
    }
    await advance(SURFACE_FIT_DEBOUNCE_MS)
    expect(fitUpliftSurface).toHaveBeenCalledTimes(1)
    expect(fitUpliftSurface.mock.calls[0][0].points[3].elevation_m).toBe(402)
  })

  it('drops a stale response that lands after newer inputs were requested', async () => {
    let resolveFirst
    fitUpliftSurface.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
    ready()
    await advance(SURFACE_FIT_DEBOUNCE_MS + 10) // first request in flight
    expect(fitUpliftSurface).toHaveBeenCalledTimes(1)

    act(() => ctx.updateAdvanced({ surface: { order: 1, hinge: 'none', extrapolation: 'warn' } }))
    await advance(SURFACE_FIT_DEBOUNCE_MS + 10) // second request answers
    const second = ctx.formState.surfaceFit
    expect(second.status).toBe('ready')

    await act(async () => resolveFirst({ ...RESPONSE, interval_m: 999 })) // the old one finally lands
    expect(ctx.formState.surfaceFit).toEqual(second)
    expect(ctx.formState.surfaceFit.data.interval_m).toBe(10)
  })

  it('an error keeps the message and no data', async () => {
    fitUpliftSurface.mockRejectedValueOnce(new Error('The shore points must not all be at the same location.'))
    ready()
    await advance(SURFACE_FIT_DEBOUNCE_MS + 10)
    expect(ctx.formState.surfaceFit).toEqual({
      status: 'error', data: null, error: 'The shore points must not all be at the same location.', key: null
    })
  })

  it('Basic mode never fits', async () => {
    ready()
    edit({ mode: 'basic' })
    await advance(SURFACE_FIT_DEBOUNCE_MS + 600)
    expect(fitUpliftSurface).not.toHaveBeenCalled()
  })
})
