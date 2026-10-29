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

beforeEach(() => window.localStorage.clear())

describe('TiltModelBody', () => {
  it('linear: only the shared inputs; the hinge shows the same three options for every family', () => {
    renderBody()
    expect(screen.getByLabelText('Single azimuth')).toBeInTheDocument()
    expect(screen.getByLabelText('Gradient at spillway (m/km)')).toBeInTheDocument()
    expect(screen.queryByLabelText(/Rate of increase/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Formula')).not.toBeInTheDocument()
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

  it('tilt lives in the Profile block: the gradient sits under the Profile heading, apart from the direction', () => {
    renderBody()
    const heading = screen.getByText('Profile')
    const gradient = screen.getByLabelText('Gradient at spillway (m/km)')
    const azimuth = screen.getByLabelText('Single azimuth')
    // The azimuth comes before the Profile heading, the gradient after it.
    expect(azimuth.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(heading.compareDocumentPosition(gradient) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('quadratic: a rate of increase (m/km per km), required, with its help; no second-gradient form', async () => {
    const user = userEvent.setup()
    renderBody()
    await pick(user, 'Profile family', 'quadratic')

    const rate = screen.getByLabelText('Rate of increase (m/km per km)')
    expect(rate).toHaveAttribute('placeholder', 'm/km per km')
    expect(rate.className).toMatch(/border-blue-400/) // required and empty
    expect(screen.getByText(/0 gives a linear profile/)).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Curvature from' })).not.toBeInTheDocument()
    expect(screen.queryByText(/second gradient/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Formula')).not.toBeInTheDocument()
  })

  it('numeric fields are text inputs that accept exponent notation and flag junk', async () => {
    const user = userEvent.setup()
    renderBody()
    await pick(user, 'Profile family', 'quadratic')
    const rate = screen.getByLabelText('Rate of increase (m/km per km)')
    expect(rate).toHaveAttribute('type', 'text')

    await user.type(rate, '4e-3')
    expect(rate).toHaveValue('4e-3')
    expect(rate).not.toHaveAttribute('aria-invalid')
    expect(rate.className).toMatch(/border-green-500/)

    await user.clear(rate)
    await user.type(rate, 'abc')
    expect(rate).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Enter a number.')).toBeInTheDocument()
  })

  it('switching family keeps the values typed for the others', async () => {
    const user = userEvent.setup()
    renderBody()
    await pick(user, 'Profile family', 'quadratic')
    await user.type(screen.getByLabelText('Rate of increase (m/km per km)'), '4e-3')
    await pick(user, 'Profile family', 'polynomial')
    await user.type(screen.getByLabelText('Formula'), '2e-4 x^2')
    await pick(user, 'Profile family', 'quadratic')
    expect(screen.getByLabelText('Rate of increase (m/km per km)')).toHaveValue('4e-3')
    expect(ctx.formState.advanced.profile.formula).toBe('2e-4 x^2') // kept while hidden
  })

  it('polynomial: a formula box with a unit-free placeholder and format help beneath it', async () => {
    const user = userEvent.setup()
    renderBody()
    await pick(user, 'Profile family', 'polynomial')

    const formula = screen.getByLabelText('Formula')
    expect(formula).toHaveAttribute('type', 'text')
    expect(formula).toHaveAttribute('placeholder', 'a x^p + …')
    expect(formula.className).toMatch(/border-blue-400/) // required and empty
    expect(screen.getByText(/Write the curve's extra terms as a x\^p/)).toBeInTheDocument()
    expect(screen.getByText(/x is the distance in km up the uplift direction from the spillway/)).toBeInTheDocument()
    expect(screen.getByText(/p is a whole number from 2 to 5/)).toBeInTheDocument()
    expect(screen.getByText(/The linear term is the gradient above/)).toBeInTheDocument()
    // The old degree + coefficient slots are gone.
    expect(screen.queryByLabelText('Degree')).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^c₂/)).not.toBeInTheDocument()
  })

  it('polynomial: live feedback - green and "Reads as ..." when valid, red with the reason when not', async () => {
    const user = userEvent.setup()
    renderBody()
    await pick(user, 'Profile family', 'polynomial')
    const formula = screen.getByLabelText('Formula')

    await user.type(formula, '2e-4 x')
    expect(formula).toHaveAttribute('aria-invalid', 'true')
    expect(formula.className).toMatch(/border-red-400/)
    expect(screen.getByText(/Every term needs an exponent from 2 to 5/)).toBeInTheDocument()

    await user.type(formula, '^2 - 1.5e-7 x^3')
    expect(formula).not.toHaveAttribute('aria-invalid')
    expect(formula.className).toMatch(/border-green-500/)
    expect(screen.getByText('Reads as c₂ = 0.0002 m/km², c₃ = −1.5e-7 m/km³')).toBeInTheDocument()
    expect(ctx.formState.advanced.profile.formula).toBe('2e-4 x^2 - 1.5e-7 x^3')

    await user.clear(formula)
    expect(formula.className).toMatch(/border-blue-400/) // empty again: required, not an error
    expect(screen.queryByText(/Reads as/)).not.toBeInTheDocument()
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

  it('has no paper references, and no numbers in any placeholder (the one format example is in the formula help)', async () => {
    const user = userEvent.setup()
    const { container } = renderBody()
    for (const family of ['quadratic', 'polynomial']) {
      await pick(user, 'Profile family', family)
      const placeholders = Array.from(container.querySelectorAll('[placeholder]')).map((e) =>
        e.getAttribute('placeholder')
      )
      for (const ph of placeholders) expect(ph).not.toMatch(/\d\.\d|e-\d|e\.g\./i)
      expect(container.textContent).not.toMatch(/Lewis|Table 3|e\.g\./)
    }
  })

  it('shows the preview chart for a single direction', async () => {
    renderBody()
    expect(screen.getByText(/Fill in the tilt parameters/)).toBeInTheDocument()

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
  })
})
