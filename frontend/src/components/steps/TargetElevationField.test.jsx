import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'

import { ProcessingProvider, useProcessing } from '../../context/ProcessingContext.jsx'
import { TargetElevationField } from './TiltAndProductsSteps.jsx'

const NOTE =
  "Strandlines are extracted at the spillway's present elevation, assuming the sill hasn't changed since the shoreline formed."

let ctx
function Readout() {
  ctx = useProcessing()
  return null
}

function renderField() {
  return render(
    <ProcessingProvider>
      <TargetElevationField />
      <Readout />
    </ProcessingProvider>
  )
}

beforeEach(() => window.localStorage.clear())

describe('TargetElevationField spillway-elevation note', () => {
  it.each(['idle', 'checking', 'dem', 'outside_bounds', 'nodata'])(
    'shows the muted note in the %s state',
    (elevationCheckStatus) => {
      renderField()
      act(() => ctx.updateForm({ elevationCheckStatus, elevationCheckValue: 812 }))
      expect(screen.getByText(NOTE)).toBeInTheDocument()
    }
  )

  it.each(['basic', 'advanced'])('shows it in %s mode (the field is shared)', (mode) => {
    renderField()
    act(() => ctx.updateForm({ mode }))
    expect(screen.getByText(NOTE)).toBeInTheDocument()
    expect(screen.getByText(NOTE)).toHaveClass('text-gray-500')
  })
})
