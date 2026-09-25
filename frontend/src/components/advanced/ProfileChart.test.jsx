import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import ProfileChart, { describeCurve, upliftAt } from './ProfileChart.jsx'

// A concave-up quadratic held flat behind a clamp at -54 km. Realistic example
// values only -- the tool has no such defaults.
function preview(overrides = {}) {
  const d = Array.from({ length: 41 }, (_, i) => -100 + i * 7.5) // -100 .. 200
  const hinge = -54
  const U = (x) => 0.35 * Math.max(x, hinge) + 0.003247 * Math.max(x, hinge) ** 2
  return {
    status: 'ready',
    error: null,
    data: {
      d_km: d,
      uplift_m: d.map(U),
      gradient_m_per_km: d.map((x) => (x < hinge ? 0 : 0.35 + 0.006494 * x)),
      d_range_km: [-100, 200],
      hinge_km: hinge,
      hinge_source: 'guard',
      warnings: [],
      ...overrides
    }
  }
}

describe('ProfileChart', () => {
  it('renders the hinge marker when hinge_km is present and in range', () => {
    render(<ProfileChart preview={preview()} />)
    expect(screen.getByTestId('hinge-marker')).toBeInTheDocument()
    expect(screen.getByTestId('clamped-segment')).toHaveAttribute('stroke-dasharray')
    expect(screen.getByTestId('profile-line')).not.toHaveAttribute('stroke-dasharray')
  })

  it('omits the marker and the dashed segment when hinge_km is null', () => {
    render(<ProfileChart preview={preview({ hinge_km: null, hinge_source: null })} />)
    expect(screen.queryByTestId('hinge-marker')).not.toBeInTheDocument()
    expect(screen.queryByTestId('clamped-segment')).not.toBeInTheDocument()
  })

  it('omits the marker when the hinge lies beyond the plotted range', () => {
    render(<ProfileChart preview={preview({ hinge_km: -500 })} />)
    expect(screen.queryByTestId('hinge-marker')).not.toBeInTheDocument()
  })

  it('labels the zero line "spillway", not "origin"', () => {
    render(<ProfileChart preview={preview()} />)
    expect(screen.getByTestId('origin-line')).toHaveTextContent('spillway')
    expect(screen.getByTestId('origin-line')).not.toHaveTextContent('origin')
  })

  it('summarises the curve in an aria-label that mentions the spillway', () => {
    render(<ProfileChart preview={preview()} />)
    const label = screen.getByRole('img').getAttribute('aria-label')
    expect(label).toMatch(
      /^Uplift versus distance from the spillway: from −\d+(\.\d+)? m at −54 km \(hinge\) to \d+ m at 200 km$/
    )
    expect(label).not.toMatch(/origin/i)
  })

  it('describeCurve starts at the range edge when there is no hinge', () => {
    const { data } = preview({ hinge_km: null })
    expect(describeCurve(data)).toMatch(/at −100 km to \d+ m at 200 km$/)
    expect(describeCurve(data)).not.toContain('(hinge)')
  })

  describe('second-gradient marker', () => {
    const point = { gradient: 0.7, distanceKm: 100 }

    it('appears on the curve when that form is active, and is described in the aria-label', () => {
      render(<ProfileChart preview={preview()} secondGradient={point} />)
      expect(screen.getByTestId('second-gradient-marker')).toBeInTheDocument()
      expect(screen.getByText('Second gradient: 0.7 m/km at 100 km')).toBeInTheDocument()
      expect(screen.getByRole('img').getAttribute('aria-label')).toContain(
        'second gradient of 0.7 m/km marked at 100 km'
      )
    })

    it('is absent when the other form is active (no point passed)', () => {
      render(<ProfileChart preview={preview()} secondGradient={null} />)
      expect(screen.queryByTestId('second-gradient-marker')).not.toBeInTheDocument()
      expect(screen.getByRole('img').getAttribute('aria-label')).not.toContain('second gradient')
    })

    it('is absent when its distance lies beyond the plotted range', () => {
      render(<ProfileChart preview={preview()} secondGradient={{ gradient: 0.7, distanceKm: 900 }} />)
      expect(screen.queryByTestId('second-gradient-marker')).not.toBeInTheDocument()
    })

    it('sits on the curve: upliftAt interpolates the returned samples', () => {
      const { data } = preview()
      // Linear interpolation between samples 7.5 km apart: close, not exact.
      expect(upliftAt(data, 0)).toBeCloseTo(0, 1)
      expect(upliftAt(data, 100)).toBeCloseTo(0.35 * 100 + 0.003247 * 100 ** 2, 0)
      expect(upliftAt(data, 500)).toBeNull()
      expect(upliftAt(data, -500)).toBeNull()
    })
  })

  describe('guard note', () => {
    it('shows the guard as information (not a warning) when the guard sets the clamp', () => {
      render(<ProfileChart preview={preview()} />)
      expect(
        screen.getByText(
          "The profile's gradient reaches zero 54 km behind the spillway; uplift is held constant beyond that point."
        )
      ).toBeInTheDocument()
    })

    it('is absent when the mode sets the clamp, or nothing does', () => {
      const { rerender } = render(<ProfileChart preview={preview({ hinge_km: 0, hinge_source: 'mode' })} />)
      expect(screen.queryByText(/gradient reaches zero/)).not.toBeInTheDocument()
      rerender(<ProfileChart preview={preview({ hinge_km: null, hinge_source: null })} />)
      expect(screen.queryByText(/gradient reaches zero/)).not.toBeInTheDocument()
    })
  })

  it('renders warnings beneath the chart', () => {
    render(<ProfileChart preview={preview({ warnings: ['The profile gradient changes sign'] })} />)
    expect(screen.getByText('The profile gradient changes sign')).toBeInTheDocument()
  })

  it('shows a placeholder, a loading note, or the error when there is no data', () => {
    const { rerender } = render(<ProfileChart preview={null} />)
    expect(screen.getByText(/Fill in the tilt parameters/)).toBeInTheDocument()
    rerender(<ProfileChart preview={{ status: 'loading', data: null, error: null }} />)
    expect(screen.getByText(/Updating preview/)).toBeInTheDocument()
    rerender(<ProfileChart preview={{ status: 'error', data: null, error: 'bad model' }} />)
    expect(screen.getByText('bad model')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('handles a flat profile without dividing by zero', () => {
    const data = {
      d_km: [-10, 0, 10],
      uplift_m: [0, 0, 0],
      gradient_m_per_km: [0, 0, 0],
      d_range_km: [-10, 10],
      hinge_km: null,
      hinge_source: null,
      warnings: []
    }
    render(<ProfileChart preview={{ status: 'ready', error: null, data }} />)
    expect(screen.getByRole('img').innerHTML).not.toContain('NaN')
  })
})
