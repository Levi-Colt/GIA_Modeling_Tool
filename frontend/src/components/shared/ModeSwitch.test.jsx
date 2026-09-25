import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ProcessingProvider, useProcessing } from '../../context/ProcessingContext.jsx'
import ModeSwitch from './ModeSwitch.jsx'

function Readout() {
  const { formState } = useProcessing()
  return <div data-testid="state">{JSON.stringify({ mode: formState.mode, az: formState.tiltAzimuth })}</div>
}

beforeEach(() => window.localStorage.clear())

describe('ModeSwitch', () => {
  it('is a labelled group of aria-pressed buttons that only changes mode', async () => {
    const onSwitch = vi.fn()
    window.localStorage.setItem('gia-tool:last-run', JSON.stringify({ tiltAzimuth: '77' }))
    render(
      <ProcessingProvider>
        <ModeSwitch onSwitch={onSwitch} />
        <Readout />
      </ProcessingProvider>
    )
    const user = userEvent.setup()
    expect(screen.getByRole('group', { name: 'Input mode' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Basic' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Planar, linear tilt')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Advanced' }))
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Basic' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('All settings kept when switching')).toBeInTheDocument()
    expect(JSON.parse(screen.getByTestId('state').textContent)).toEqual({ mode: 'advanced', az: '77' })
    expect(onSwitch).toHaveBeenCalledTimes(1)
  })
})
