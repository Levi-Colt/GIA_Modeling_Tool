import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ProcessingProvider, useProcessing } from '../../context/ProcessingContext.jsx'
import AdvancedForm from './AdvancedForm.jsx'
import { runPreflight } from '../../api/client.js'

vi.mock('../../api/client.js', () => ({
  runPreflight: vi.fn(),
  rasterPreview: vi.fn().mockRejectedValue(new Error('no preview in tests')),
  originElevation: vi.fn(),
  resolvePoint: vi.fn()
}))
vi.mock('georaster', () => ({ default: vi.fn() }))

const STORAGE_KEY = 'gia-tool:last-run'
const ALL_CLOSED = { dem: false, origin: false, tilt: false, output: false }

function seed(sectionsOpen) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: 'advanced', advanced: { sectionsOpen } }))
}

let ctx
function Readout() {
  ctx = useProcessing()
  return null
}

function renderForm(props = {}) {
  return render(
    <ProcessingProvider>
      <AdvancedForm {...props} />
      <Readout />
    </ProcessingProvider>
  )
}

const sectionButton = (name) => screen.getByRole('button', { name: new RegExp('^' + name, 'i') })

beforeEach(() => {
  window.localStorage.clear()
  vi.clearAllMocks()
  Element.prototype.scrollIntoView = vi.fn()
})

describe('AdvancedForm focusRequest', () => {
  it('opens a collapsed tilt section and scrolls to it', async () => {
    seed(ALL_CLOSED)
    renderForm({ focusRequest: { id: 'tilt', n: 1 } })

    await waitFor(() => expect(sectionButton('Tilt model')).toHaveAttribute('aria-expanded', 'true'))
    expect(screen.getByLabelText('Single azimuth')).toBeInTheDocument()
    expect(screen.getByLabelText('Gradient at origin (m/km)')).toBeInTheDocument()
    // Only the requested section opened.
    expect(sectionButton('Output')).toHaveAttribute('aria-expanded', 'false')
    expect(ctx.formState.advanced.sectionsOpen).toEqual({ ...ALL_CLOSED, tilt: true })

    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled())
    expect(Element.prototype.scrollIntoView.mock.contexts[0].id).toBe('step-tilt')
  })

  it('routes the coordinates id to the Origin section', async () => {
    seed(ALL_CLOSED)
    renderForm({ focusRequest: { id: 'coordinates', n: 1 } })
    await waitFor(() => expect(sectionButton('Origin')).toHaveAttribute('aria-expanded', 'true'))
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled())
  })

  it('just scrolls when the section is already open', async () => {
    seed({ ...ALL_CLOSED, tilt: true })
    renderForm({ focusRequest: { id: 'tilt', n: 1 } })
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled())
    expect(ctx.formState.advanced.sectionsOpen).toEqual({ ...ALL_CLOSED, tilt: true })
  })
})

describe('AdvancedForm upload section', () => {
  it('stays mounted while collapsed; the other sections unmount', async () => {
    seed({ dem: true, origin: true, tilt: true, output: false })
    renderForm()
    const user = userEvent.setup()
    const pathInput = screen.getByPlaceholderText('/path/to/dem.tif')

    await user.click(sectionButton('DEM'))
    expect(sectionButton('DEM')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByPlaceholderText('/path/to/dem.tif')).toBe(pathInput)
    expect(pathInput).not.toBeVisible()

    await user.click(sectionButton('Tilt model'))
    expect(screen.queryByLabelText('Single azimuth')).not.toBeInTheDocument()
  })

  it('collapsing the DEM section mid-preflight does not cancel it', async () => {
    seed({ dem: true, origin: true, tilt: true, output: false })
    let finish
    runPreflight.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    renderForm()
    const user = userEvent.setup()

    await user.type(screen.getByPlaceholderText('/path/to/dem.tif'), '/data/dem.tif')
    await user.tab() // blur fires the preflight
    await waitFor(() => expect(ctx.formState.preflightStatus).toBe('checking'))

    await user.click(sectionButton('DEM')) // collapse mid-flight
    expect(sectionButton('DEM')).toHaveAttribute('aria-expanded', 'false')

    await act(async () => finish({ crs: 'EPSG:4326', bounds_wgs84: [-1, -1, 1, 1] }))
    await waitFor(() => expect(ctx.formState.preflightStatus).toBe('valid'))
    expect(ctx.formState.demPath).toBe('/data/dem.tif')

    // The status line reflects the finished check even while collapsed...
    expect(screen.getByText('/data/dem.tif')).toBeInTheDocument()
    // ...and re-expanding shows the valid state.
    await user.click(sectionButton('DEM'))
    expect(screen.getByText(/readable, EPSG:4326/)).toBeVisible()
  })
})

describe('AdvancedForm status lines', () => {
  it('shows "Needs" for incomplete sections, from getReadiness', () => {
    seed(ALL_CLOSED)
    renderForm()
    expect(screen.getByText('Needs: a valid DEM')).toBeInTheDocument()
    expect(screen.getByText('Needs: tilt azimuth, tilt factor')).toBeInTheDocument()
    expect(screen.getByText(/Needs: origin coordinates/)).toBeInTheDocument()
  })

  it('shows summaries once complete', () => {
    seed(ALL_CLOSED)
    renderForm()
    act(() =>
      ctx.updateForm({
        preflightStatus: 'valid',
        demPath: '/d/dem.tif',
        originValue: '45N,110W',
        resolvedOrigin: [-110.5, 45.25],
        targetElevation: '1500',
        elevationCheckStatus: 'dem',
        tiltAzimuth: '28',
        tiltFactor: '0.65'
      })
    )
    expect(screen.getByText('/d/dem.tif')).toBeInTheDocument()
    expect(screen.getByText('45.25000, -110.50000')).toBeInTheDocument()
    expect(screen.getByText('028° · 0.65 m/km')).toBeInTheDocument()
    expect(screen.getByText('no radius limit · with DEM')).toBeInTheDocument()
  })
})
