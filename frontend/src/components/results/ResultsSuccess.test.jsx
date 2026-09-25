import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import ResultsSuccess from './ResultsSuccess.jsx'
import { DEFAULT_HINGE, DEFAULT_PROFILE } from '../../utils/tiltModel.js'

const result = { blob: new Blob(['x']), filename: 'strandlines.gpkg' }
const baseForm = {
  mode: 'basic',
  tiltAzimuth: '28',
  tiltFactor: '0.35',
  targetElevation: '1500',
  selectionRadiusKm: '',
  includeDem: true,
  advanced: {
    profile: { ...DEFAULT_PROFILE, family: 'quadratic', curvatureInput: 'rate', rateOfIncrease: '4e-3' },
    hinge: { ...DEFAULT_HINGE, mode: 'none' }
  },
  profilePreview: { status: 'ready', error: null, data: { hinge_km: -53.9, hinge_source: 'guard' } }
}

const renderResults = (formState) =>
  render(<ResultsSuccess result={result} formState={formState} onRunAgain={() => {}} onAdjustInputs={() => {}} />)

describe('ResultsSuccess parameter line', () => {
  it('adds the family and hinge in Advanced mode, naming the guard when it set the clamp', () => {
    renderResults({ ...baseForm, mode: 'advanced' })
    expect(
      screen.getByText(/Quadratic, k = 4e-3 · hinge none, zero gradient at −53\.9 km/)
    ).toBeInTheDocument()
  })

  it('stays as it was in Basic mode, even with advanced fields populated', () => {
    renderResults(baseForm)
    expect(screen.queryByText(/Quadratic/)).not.toBeInTheDocument()
    expect(screen.queryByText(/hinge/)).not.toBeInTheDocument()
    expect(screen.getByText(/Azimuth 28/)).toBeInTheDocument()
  })

  it('drops the guard clause when no preview is available', () => {
    renderResults({ ...baseForm, mode: 'advanced', profilePreview: null })
    expect(screen.getByText(/Quadratic, k = 4e-3 · hinge none$/)).toBeInTheDocument()
  })

  it('says "at spillway" for the default hinge', () => {
    renderResults({
      ...baseForm,
      mode: 'advanced',
      advanced: { ...baseForm.advanced, hinge: DEFAULT_HINGE },
      profilePreview: { status: 'ready', error: null, data: { hinge_km: 0, hinge_source: 'mode' } }
    })
    expect(screen.getByText(/hinge at spillway$/)).toBeInTheDocument()
  })

  it('describes a second-gradient quadratic in the user-supplied terms', () => {
    renderResults({
      ...baseForm,
      mode: 'advanced',
      advanced: {
        profile: {
          ...DEFAULT_PROFILE, family: 'quadratic', curvatureInput: 'secondGradient',
          secondGradient: '1.2', secondGradientDistanceKm: '150'
        },
        hinge: DEFAULT_HINGE
      }
    })
    expect(screen.getByText(/Quadratic, second gradient 1\.2 m\/km at 150 km · hinge at spillway/)).toBeInTheDocument()
  })
})
