// Regression test for: a coordinate edited (but not re-blurred) after a
// previous successful elevation check left the stale check result --
// status 'dem', a stale targetElevation -- looking fully valid, so
// isReadyToRun would let a run submit against a coordinate that no longer
// matches the checked elevation. See CoordinateSteps.jsx's onChange
// handlers and App.jsx's isReadyToRun.
import { useEffect } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ProcessingProvider, useProcessing } from '../../context/ProcessingContext.jsx'
import { CoordinatesStep } from './CoordinateSteps.jsx'
import { isReadyToRun } from '../../utils/readiness.js'
import { originElevation, resolvePoint } from '../../api/client.js'

vi.mock('../../api/client.js', () => ({
  originElevation: vi.fn(),
  resolvePoint: vi.fn()
}))

// Seeds the form state that would normally come from UploadStep's preflight
// call and the tilt fields (irrelevant to this bug, but isReadyToRun checks
// them too), then renders the coordinate input under test alongside a
// read-out of isReadyToRun/status so assertions don't need to reach into
// React internals.
function Harness() {
  const { formState, updateForm } = useProcessing()
  useEffect(() => {
    updateForm({
      preflightStatus: 'valid',
      demPath: '/fake/dem.tif',
      tiltAzimuth: '90',
      tiltFactor: '5'
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div>
      <CoordinatesStep />
      <div data-testid="ready">{String(isReadyToRun(formState))}</div>
      <div data-testid="target-elevation">{formState.targetElevation}</div>
      <div data-testid="elevation-status">{formState.elevationCheckStatus}</div>
      <div data-testid="resolve-status">{formState.resolveOriginStatus}</div>
    </div>
  )
}

function renderHarness() {
  render(
    <ProcessingProvider>
      <Harness />
    </ProcessingProvider>
  )
}

beforeEach(() => {
  window.localStorage.clear()
  vi.clearAllMocks()
  resolvePoint.mockResolvedValue({ lon: -110.55, lat: 45.25 })
})

describe('stale target-elevation after an unblurred coordinate edit', () => {
  it('blocks isReadyToRun until a fresh blur-triggered check resolves against the current coordinate', async () => {
    originElevation.mockResolvedValueOnce({ within_bounds: true, elevation: 1234, reason: null })

    renderHarness()
    const user = userEvent.setup()
    const input = screen.getByPlaceholderText('45.25N,110.55W')

    // Type a coordinate and blur -- the check resolves and auto-fills target elevation.
    await user.type(input, '45.25N,110.55W')
    await user.tab()

    await waitFor(() => expect(screen.getByTestId('elevation-status')).toHaveTextContent('dem'))
    expect(screen.getByTestId('resolve-status')).toHaveTextContent('resolved')
    expect(screen.getByTestId('target-elevation')).toHaveTextContent('1234')
    expect(screen.getByTestId('ready')).toHaveTextContent('true')

    // Edit the coordinate again WITHOUT blurring.
    await user.type(input, '0')

    // The onChange handler resets both check statuses synchronously, before
    // any new (re-)blur-triggered network call resolves.
    expect(screen.getByTestId('elevation-status')).toHaveTextContent('idle')
    expect(screen.getByTestId('resolve-status')).toHaveTextContent('idle')
    expect(screen.getByTestId('ready')).toHaveTextContent('false')
    // The stale numeric value is still sitting in form state (that's the
    // bug's root cause) -- what changed is that isReadyToRun no longer
    // treats the form as ready because of it.
    expect(screen.getByTestId('target-elevation')).toHaveTextContent('1234')
  })

  it('becomes ready again once the edited coordinate is re-blurred', async () => {
    originElevation
      .mockResolvedValueOnce({ within_bounds: true, elevation: 1234, reason: null })
      .mockResolvedValueOnce({ within_bounds: true, elevation: 999, reason: null })

    renderHarness()
    const user = userEvent.setup()
    const input = screen.getByPlaceholderText('45.25N,110.55W')

    await user.type(input, '45.25N,110.55W')
    await user.tab()
    await waitFor(() => expect(screen.getByTestId('elevation-status')).toHaveTextContent('dem'))

    await user.type(input, '0')
    expect(screen.getByTestId('ready')).toHaveTextContent('false')

    await user.tab()
    await waitFor(() => expect(screen.getByTestId('elevation-status')).toHaveTextContent('dem'))
    expect(screen.getByTestId('target-elevation')).toHaveTextContent('999')
    expect(screen.getByTestId('ready')).toHaveTextContent('true')
  })
})
