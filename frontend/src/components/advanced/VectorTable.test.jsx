// The vectors UI inside the Tilt model section (spec 5): the optional "multiple
// directions" checkbox, the draw-on-the-map table, custom rows, fit column and the
// map-editing toggles. Vectors are only ever drawn on the map: no add-row, no import.
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ProcessingProvider, useProcessing } from '../../context/ProcessingContext.jsx'
import TiltModelBody from './TiltModelBody.jsx'
import { newVector } from '../../utils/vectors.js'

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

const global = (patch = {}) => newVector({ lat: '45', lon: '-105', azimuthDeg: '30', ...patch })
const customV = (patch = {}) =>
  newVector({ lat: '46', lon: '-104', azimuthDeg: '40', tilt: 'custom', custom: { localGradient: '0.6' }, ...patch })

// Puts the body into vectors mode with the given rows.
function withVectors(vectors) {
  act(() => {
    ctx.updateAdvanced({ directionSource: 'vectors' })
    ctx.setVectors(vectors)
  })
}
const multiBox = () => screen.getByRole('checkbox', { name: 'Use multiple directions' })

beforeEach(() => window.localStorage.clear())

describe('multiple directions', () => {
  it('is off by default: the azimuth input, the profile chart, no table', () => {
    renderBody()
    expect(multiBox()).not.toBeChecked()
    expect(screen.getByLabelText('Single azimuth')).toBeInTheDocument()
    expect(screen.getByText('Uplift preview')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Draw vector' })).not.toBeInTheDocument()
  })

  it('checking it replaces the azimuth input and the 1D chart with the table and fit summary, and arms drawing', async () => {
    const user = userEvent.setup()
    renderBody()
    await user.click(multiBox())

    expect(ctx.formState.advanced.directionSource).toBe('vectors')
    expect(ctx.formState.mapEditMode).toBe('addVector')
    expect(multiBox()).toBeChecked()
    expect(screen.queryByLabelText('Single azimuth')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Draw vector' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Global profile (whole DEM)')).toBeInTheDocument()
    // The gradient at the spillway is still there (the global profile's), and the hinge.
    expect(screen.getByLabelText('Gradient at spillway (m/km)')).toBeInTheDocument()
    expect(screen.getByLabelText('Hinge behind spillway')).toBeInTheDocument()
    // No 1D profile: it would mislead once directions vary.
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByText(/Complete the vectors, DEM and origin/)).toBeInTheDocument()
  })

  it('there is no way to add a row by hand or import a file', () => {
    renderBody()
    withVectors([])
    expect(screen.queryByRole('button', { name: '+ Add row' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Import CSV' })).not.toBeInTheDocument()
  })

  it('unchecking returns to the single azimuth and keeps the typed azimuth, gradient and drawn vectors', async () => {
    const user = userEvent.setup()
    renderBody()
    await user.type(screen.getByLabelText('Single azimuth'), '45')
    await user.type(screen.getByLabelText('Gradient at spillway (m/km)'), '0.35')
    await user.click(multiBox())
    act(() => ctx.setVectors([global()]))
    await user.click(multiBox())

    expect(ctx.formState.advanced.directionSource).toBe('azimuth')
    expect(screen.getByLabelText('Single azimuth')).toHaveValue(45)
    expect(screen.getByLabelText('Gradient at spillway (m/km)')).toHaveValue(0.35)
    expect(ctx.formState.advanced.vectors).toHaveLength(1)
  })

  it('unchecking disarms drawing', async () => {
    const user = userEvent.setup()
    renderBody()
    await user.click(multiBox())
    expect(ctx.formState.mapEditMode).toBe('addVector')
    await user.click(multiBox())
    expect(ctx.formState.mapEditMode).toBe('none')
  })

  it('switching to Shore points and back lands on the single azimuth', async () => {
    const user = userEvent.setup()
    renderBody()
    await user.click(multiBox())
    await user.click(screen.getByRole('button', { name: 'Shore points' }))
    expect(ctx.formState.advanced.directionSource).toBe('points')
    expect(ctx.formState.mapEditMode).toBe('none')
    await user.click(screen.getByRole('button', { name: 'Uplift direction' }))
    expect(ctx.formState.advanced.directionSource).toBe('azimuth')
  })
})

describe('vectors table', () => {
  it('shows an empty state until a row exists', () => {
    renderBody()
    withVectors([])
    expect(screen.getByText(/No vectors yet/)).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('a drawn row is numbered and labelled, with editable start point, azimuth and range', () => {
    renderBody()
    const v = newVector({ lat: '45', lon: '-105', azimuthDeg: '30', rangeKm: '80' })
    withVectors([v])

    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).toEqual(['#', 'Lat', 'Lon', 'Azim °', 'Range km', 'Tilt', 'Fit °', 'Remove'])
    expect(screen.getByLabelText('Vector 1 latitude')).toHaveValue('45')
    expect(screen.getByLabelText('Vector 1 longitude')).toHaveValue('-105')
    expect(screen.getByLabelText('Vector 1 azimuth')).toHaveValue('30')
    expect(screen.getByLabelText('Vector 1 range (km)')).toHaveValue('80')
    expect(screen.getByLabelText('Vector 1 tilt')).toHaveValue('global')
  })

  it('editing a cell edits the vector (the map redraws from the same row)', async () => {
    const user = userEvent.setup()
    renderBody()
    withVectors([global()])
    const az = screen.getByLabelText('Vector 1 azimuth')
    await user.clear(az)
    await user.type(az, '95')
    expect(ctx.formState.advanced.vectors[0].azimuthDeg).toBe('95')
  })

  it('placeholders are units only, with no example values', async () => {
    renderBody()
    withVectors([newVector()])
    expect(screen.getByLabelText('Vector 1 latitude')).toHaveAttribute('placeholder', 'deg')
    expect(screen.getByLabelText('Vector 1 azimuth')).toHaveAttribute('placeholder', 'deg')
    expect(screen.getByLabelText('Vector 1 range (km)')).toHaveAttribute('placeholder', 'km')
  })

  it('editing a cell updates the row (as text) without adding an undo step', async () => {
    const user = userEvent.setup()
    renderBody()
    withVectors([global()])
    await user.clear(screen.getByLabelText('Vector 1 azimuth'))
    await user.type(screen.getByLabelText('Vector 1 azimuth'), '1.5e2')
    expect(ctx.formState.advanced.vectors[0].azimuthDeg).toBe('1.5e2')
    expect(ctx.undoDepth).toBe(0)
  })

  it('flags an invalid cell', async () => {
    renderBody()
    withVectors([global({ lat: '91', rangeKm: '-4' })])
    expect(screen.getByLabelText('Vector 1 latitude')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Vector 1 range (km)')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Vector 1 longitude')).not.toHaveAttribute('aria-invalid')
  })

  it('every remove button has an aria-label naming its row; Undo brings the row back', async () => {
    const user = userEvent.setup()
    renderBody()
    withVectors([global({ lat: '1' }), global({ lat: '2' })])
    expect(screen.getByRole('button', { name: 'Remove vector 1' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove vector 2' }))
    expect(ctx.formState.advanced.vectors).toHaveLength(1)

    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(ctx.formState.advanced.vectors.map((v) => v.lat)).toEqual(['1', '2'])
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
  })

  it('selecting a row (focus or click) selects it, and vice versa', async () => {
    const user = userEvent.setup()
    renderBody()
    const [a, b] = [global(), global({ lat: '46' })]
    withVectors([a, b])

    await user.click(screen.getByLabelText('Vector 2 latitude'))
    expect(ctx.formState.selectedVectorId).toBe(b.id)
    expect(document.getElementById(`vector-row-${b.id}`)).toHaveAttribute('aria-selected', 'true')
    expect(document.getElementById(`vector-row-${a.id}`)).toHaveAttribute('aria-selected', 'false')

    act(() => ctx.selectVector(a.id)) // e.g. clicked on the map
    expect(document.getElementById(`vector-row-${a.id}`)).toHaveAttribute('aria-selected', 'true')
  })

  it('the Fit column shows the misfit, amber above 15°', () => {
    renderBody()
    withVectors([global(), global(), global()])
    act(() =>
      ctx.updateForm({
        upliftPreview: {
          status: 'ready',
          error: null,
          data: { vectors: [{ index: 0, misfit_deg: 2.14 }, { index: 1, misfit_deg: 22.5 }, { index: 2, misfit_deg: null }] }
        }
      })
    )
    const fit = (n) => screen.getByLabelText(`Vector ${n} fit`)
    expect(fit(1)).toHaveTextContent('2.1°')
    expect(fit(1).className).not.toMatch(/amber/)
    expect(fit(2)).toHaveTextContent('22.5°')
    expect(fit(2).className).toMatch(/text-amber-600/)
    expect(fit(3)).toHaveTextContent('—') // outside the fitted area: not measured
  })

  it('shows the fit summary, the guard note and preview warnings', () => {
    renderBody()
    withVectors([global()])
    act(() =>
      ctx.updateForm({
        upliftPreview: {
          status: 'ready',
          error: null,
          data: {
            vectors: [{ index: 0, misfit_deg: 1 }],
            misfit_rms_deg: 2.4, misfit_max_deg: 5.06, worst_vector: 1, interval_m: 10,
            hinge_source: 'guard', hinge_km: -20, warnings: ['Vectors disagree strongly (near-opposite directions).']
          }
        }
      })
    )
    expect(screen.getByText('Direction fit: RMS 2.4°, max 5.1° (vector 2). Isobases every 10 m.')).toBeInTheDocument()
    expect(screen.getByText(/gradient reaches zero 20 km behind the spillway/)).toBeInTheDocument()
    expect(screen.getByText(/Vectors disagree strongly/)).toBeInTheDocument()
  })
})

describe('custom rows', () => {
  it('choosing Custom expands a row below with the family and local gradient; Global hides it, keeping values', async () => {
    const user = userEvent.setup()
    renderBody()
    withVectors([global()])
    expect(screen.queryByText('Custom tilt for vector 1')).not.toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Vector 1 tilt'), 'custom')
    expect(screen.getByText('Custom tilt for vector 1')).toBeInTheDocument()
    expect(screen.getByLabelText('Vector 1 custom family')).toHaveValue('linear')
    await user.type(screen.getByLabelText('Vector 1 local gradient (m/km)'), '0.6')
    expect(screen.getByLabelText('Vector 1 local gradient (m/km)')).toHaveAttribute('placeholder', 'm/km')

    await user.selectOptions(screen.getByLabelText('Vector 1 tilt'), 'global')
    expect(screen.queryByText('Custom tilt for vector 1')).not.toBeInTheDocument()
    expect(ctx.formState.advanced.vectors[0].custom.localGradient).toBe('0.6') // kept
  })

  it('a quadratic has the same "Curvature from" control as the global profile, second gradient by default', async () => {
    const user = userEvent.setup()
    renderBody()
    withVectors([customV()])
    await user.selectOptions(screen.getByLabelText('Vector 1 custom family'), 'quadratic')

    const group = screen.getByRole('group', { name: 'Vector 1 curvature from' })
    expect(within(group).getByRole('button', { name: 'Second gradient' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('Vector 1 second gradient (m/km)')).toBeInTheDocument()
    expect(screen.getByLabelText(/Vector 1 distance \(km\) up the uplift direction from this vector/)).toHaveAttribute(
      'placeholder',
      'km'
    )
    expect(screen.queryByLabelText(/Vector 1 rate of increase/)).not.toBeInTheDocument()

    await user.type(screen.getByLabelText('Vector 1 second gradient (m/km)'), '1.2')
    await user.click(within(group).getByRole('button', { name: 'Rate of increase' }))
    const rate = screen.getByLabelText('Vector 1 rate of increase (m/km per km)')
    expect(rate).toHaveAttribute('placeholder', 'm/km per km')
    await user.type(rate, '4e-3')
    expect(ctx.formState.advanced.vectors[0].custom).toMatchObject({
      family: 'quadratic', curvatureInput: 'rate', rateOfIncrease: '4e-3', secondGradient: '1.2' // hidden value kept
    })
  })

  it('shows the muted note only while every vector is custom, and the fields stay editable', () => {
    renderBody()
    withVectors([customV(), customV()])
    expect(
      screen.getByText('Global profile not used — every vector has a custom tilt. The hinge below still applies.')
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Gradient at spillway (m/km)')).toBeEnabled()

    act(() => ctx.setVectors((l) => [...l, global()]))
    expect(screen.queryByText(/Global profile not used/)).not.toBeInTheDocument()
  })

  it('has no note for an empty list', () => {
    renderBody()
    withVectors([])
    expect(screen.queryByText(/Global profile not used/)).not.toBeInTheDocument()
  })
})

describe('map editing controls', () => {
  it('"Draw vector" toggles the transient edit mode', async () => {
    const user = userEvent.setup()
    renderBody()
    withVectors([])
    const toggle = screen.getByRole('button', { name: 'Draw vector' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await user.click(toggle)
    expect(ctx.formState.mapEditMode).toBe('addVector')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/Drag on the map to draw a vector/)).toBeInTheDocument()
    await user.click(toggle)
    expect(ctx.formState.mapEditMode).toBe('none')
  })

  it('a focus request (a click-added vector with no azimuth) focuses that row\'s azimuth input, once', () => {
    renderBody()
    const v = newVector({ lat: '45', lon: '-105' })
    withVectors([v])
    act(() => ctx.requestVectorFocus(v.id))
    expect(screen.getByLabelText('Vector 1 azimuth')).toHaveFocus()
    expect(ctx.formState.vectorFocusRequest).toBeNull() // handled, so a remount can't steal focus again
  })
})
