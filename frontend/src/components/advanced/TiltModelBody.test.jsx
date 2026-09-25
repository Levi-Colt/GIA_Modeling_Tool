import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ProcessingProvider, useProcessing } from '../../context/ProcessingContext.jsx'
import TiltModelBody from './TiltModelBody.jsx'

let ctx
function Readout() {
  ctx = useProcessing()
  return null
}

function renderBody() {
  return render(
    <ProcessingProvider>
      <TiltModelBody />
      <Readout />
    </ProcessingProvider>
  )
}

const pick = async (user, label, option) => user.selectOptions(screen.getByLabelText(label), option)
const hingeOptions = () =>
  Array.from(screen.getByLabelText('Hinge behind spillway').querySelectorAll('option')).map((o) => o.textContent)
const curvatureButton = (name) => screen.getByRole('button', { name })

beforeEach(() => window.localStorage.clear())

describe('TiltModelBody', () => {
  it('linear: only the shared inputs; the hinge shows the same three options for every family', () => {
    renderBody()
    expect(screen.getByLabelText('Single azimuth')).toBeInTheDocument()
    expect(screen.getByLabelText('Gradient at spillway (m/km)')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Curvature from' })).not.toBeInTheDocument()
    expect(hingeOptions()).toEqual([
      'At spillway (default)',
      'Distance behind spillway…',
      'None: continue behind spillway'
    ])
    expect(screen.getByLabelText('Hinge behind spillway')).toHaveValue('origin')
  })

  it('shows the neutral help texts', () => {
    renderBody()
    expect(
      screen.getByText(
        "Present-day slope of this shoreline's (tilted) water plane at the spillway, measured in the direction of maximum uplift."
      )
    ).toBeInTheDocument()
    expect(screen.getByText('Where uplift stops changing as you move behind the spillway.')).toBeInTheDocument()
  })

  it('quadratic: "Curvature from" defaults to Second gradient, with its own fields and help', async () => {
    const user = userEvent.setup()
    renderBody()
    await pick(user, 'Profile family', 'quadratic')

    expect(screen.getByRole('group', { name: 'Curvature from' })).toBeInTheDocument()
    expect(curvatureButton('Second gradient')).toHaveAttribute('aria-pressed', 'true')
    expect(curvatureButton('Rate of increase')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByLabelText('Gradient (m/km)')).toHaveAttribute('placeholder', 'm/km')
    expect(screen.getByLabelText(/^at distance \(km\) up the uplift direction from the spillway/)).toHaveAttribute(
      'placeholder',
      'km'
    )
    expect(screen.getByText(/the curve is fitted through both/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/Rate of increase/)).not.toBeInTheDocument()
  })

  it('switching to Rate of increase shows the rate input and its help; hidden values are kept', async () => {
    const user = userEvent.setup()
    renderBody()
    await pick(user, 'Profile family', 'quadratic')
    await user.type(screen.getByLabelText('Gradient (m/km)'), '1.2')
    await user.type(screen.getByLabelText(/^at distance/), '150')

    await user.click(curvatureButton('Rate of increase'))
    const rate = screen.getByLabelText('Rate of increase (m/km per km)')
    expect(rate).toHaveAttribute('placeholder', 'm/km per km')
    expect(screen.getByText(/0 gives a linear profile/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Gradient (m/km)')).not.toBeInTheDocument()
    await user.type(rate, '4e-3')

    await user.click(curvatureButton('Second gradient'))
    expect(screen.getByLabelText('Gradient (m/km)')).toHaveValue('1.2')
    expect(screen.getByLabelText(/^at distance/)).toHaveValue('150')
    expect(ctx.formState.advanced.profile.rateOfIncrease).toBe('4e-3') // kept while hidden
  })

  it('numeric fields are text inputs that accept exponent notation and flag junk', async () => {
    const user = userEvent.setup()
    renderBody()
    await pick(user, 'Profile family', 'quadratic')
    await user.click(curvatureButton('Rate of increase'))
    const rate = screen.getByLabelText('Rate of increase (m/km per km)')
    expect(rate).toHaveAttribute('type', 'text')

    await user.type(rate, '4e-3')
    expect(rate).toHaveValue('4e-3')
    expect(rate).not.toHaveAttribute('aria-invalid')

    await user.clear(rate)
    await user.type(rate, 'abc')
    expect(rate).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Enter a number.')).toBeInTheDocument()
  })

  it('a second-gradient distance of zero is flagged', async () => {
    const user = userEvent.setup()
    renderBody()
    await pick(user, 'Profile family', 'quadratic')
    await user.type(screen.getByLabelText(/^at distance/), '0')
    expect(screen.getByLabelText(/^at distance/)).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Enter a number greater than 0.')).toBeInTheDocument()
  })

  it('polynomial: unit-only placeholders, the help text, and coefficient inputs following the degree', async () => {
    const user = userEvent.setup()
    renderBody()
    await pick(user, 'Profile family', 'polynomial')

    // Default degree 3 -> c2, c3.
    expect(screen.getByLabelText(/^c₂ \(m\/km²\)/)).toHaveAttribute('placeholder', 'm/km²')
    expect(screen.getByLabelText(/^c₃ \(m\/km³\)/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/^c₄/)).not.toBeInTheDocument()
    expect(screen.getByText(/Terms of U\(d\) = g₀·d \+ c₂·d²/)).toBeInTheDocument()

    await pick(user, 'Degree', '5')
    await user.type(screen.getByLabelText(/^c₄/), '1e-6')
    expect(screen.getByLabelText(/^c₅ \(m\/km⁵\)/)).toBeInTheDocument()

    await pick(user, 'Degree', '2')
    expect(screen.queryByLabelText(/^c₃/)).not.toBeInTheDocument()
    expect(ctx.formState.advanced.profile.coefficients[2]).toBe('1e-6') // hidden but kept

    await pick(user, 'Degree', '4')
    expect(screen.getByLabelText(/^c₄/)).toHaveValue('1e-6')
  })

  it('a distance hinge reveals a km input (placeholder "km"); other modes hide it but keep the value', async () => {
    const user = userEvent.setup()
    renderBody()
    expect(screen.queryByLabelText('Hinge distance (km)')).not.toBeInTheDocument()

    await pick(user, 'Hinge behind spillway', 'distance')
    const km = screen.getByLabelText('Hinge distance (km)')
    expect(km).toHaveAttribute('placeholder', 'km')
    await user.type(km, '30')
    expect(ctx.formState.advanced.hinge).toEqual({ mode: 'distance', distanceKm: '30' })

    await pick(user, 'Hinge behind spillway', 'none')
    expect(screen.queryByLabelText('Hinge distance (km)')).not.toBeInTheDocument()
    expect(ctx.formState.advanced.hinge).toEqual({ mode: 'none', distanceKm: '30' })
  })

  it('linear + None is selectable (valid)', async () => {
    const user = userEvent.setup()
    renderBody()
    await pick(user, 'Hinge behind spillway', 'none')
    expect(ctx.formState.advanced.hinge.mode).toBe('none')
    expect(screen.getByLabelText('Hinge behind spillway')).toHaveValue('none')
  })

  it('has no example numbers or paper references in any placeholder or help text', async () => {
    const user = userEvent.setup()
    const { container } = renderBody()
    for (const family of ['quadratic', 'polynomial']) {
      await pick(user, 'Profile family', family)
      if (family === 'quadratic') await user.click(curvatureButton('Rate of increase'))
      const placeholders = Array.from(container.querySelectorAll('[placeholder]')).map((e) =>
        e.getAttribute('placeholder')
      )
      for (const p of placeholders) expect(p).not.toMatch(/\d\.\d|e-\d|e\.g\./i)
      expect(container.textContent).not.toMatch(/Lewis|Table 3|e\.g\./)
    }
  })

  it('shows the preview chart, marking the second gradient while that form is active', async () => {
    const user = userEvent.setup()
    renderBody()
    expect(screen.getByText(/Fill in the tilt parameters/)).toBeInTheDocument()
    await pick(user, 'Profile family', 'quadratic')
    await user.type(screen.getByLabelText('Gradient (m/km)'), '0.7')
    await user.type(screen.getByLabelText(/^at distance/), '5')

    act(() =>
      ctx.updateForm({
        profilePreview: {
          status: 'ready',
          error: null,
          data: {
            d_km: [-10, 0, 10],
            uplift_m: [0, 0, 3.5],
            gradient_m_per_km: [0, 0.35, 0.35],
            d_range_km: [-10, 10],
            hinge_km: 0,
            hinge_source: 'mode',
            warnings: []
          }
        }
      })
    )
    expect(screen.getByRole('img')).toBeInTheDocument()
    expect(screen.getByTestId('second-gradient-marker')).toBeInTheDocument()

    await user.click(curvatureButton('Rate of increase'))
    expect(screen.queryByTestId('second-gradient-marker')).not.toBeInTheDocument()
  })
})
