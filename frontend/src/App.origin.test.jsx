// Origin entry is decimal degrees only, typed or picked on the map; the field shows
// its own state (blue / checking / green / red). MapPanel is mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

let mapProps
vi.mock('./components/map/MapPanel.jsx', () => ({
  default: (props) => {
    mapProps = props
    return <div data-testid="map" />
  }
}))
vi.mock('./api/client.js', () => ({
  upliftPreview: vi.fn(),
  profilePreview: vi.fn().mockResolvedValue({}),
  runPreflight: vi.fn(),
  rasterPreview: vi.fn(),
  resolvePoint: vi.fn(),
  originElevation: vi.fn(),
  runProcess: vi.fn()
}))

import App from './App.jsx'
import { originElevation, rasterPreview, resolvePoint, runPreflight } from './api/client.js'

const STORAGE_KEY = 'gia-tool:last-run'
const origin = () => screen.getByPlaceholderText('latitude, longitude')

beforeEach(() => {
  window.localStorage.clear()
  mapProps = null
  vi.clearAllMocks()
})

describe('origin field', () => {
  it('has no mode selector or EPSG input: decimal degrees only', () => {
    render(<App />)
    expect(screen.queryByRole('combobox', { name: /mode/i })).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/EPSG/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Match raster/i)).not.toBeInTheDocument()
  })

  it('is blue while empty, then shows its own lookup state, green once located', async () => {
    let finish
    resolvePoint.mockReturnValue(new Promise((res) => (finish = res)))
    render(<App />)
    const user = userEvent.setup()
    expect(origin().className).toMatch(/border-blue-400/)

    await user.type(origin(), '45.25N, 110.55W')
    await user.tab()
    expect(await screen.findByText('Looking up origin...')).toBeInTheDocument()

    await act(async () => finish({ lon: -110.55, lat: 45.25 }))
    expect(await screen.findByText('Origin located.')).toBeInTheDocument()
    expect(origin().className).toMatch(/border-green-500/)
  })

  it('goes red with the reason the API gave when the coordinate cannot be read', async () => {
    resolvePoint.mockRejectedValue(new Error('"45" is not a valid decimal-degrees value.'))
    render(<App />)
    const user = userEvent.setup()
    await user.type(origin(), '45, 110')
    await user.tab()
    expect(await screen.findByText(/is not a valid decimal-degrees value/)).toBeInTheDocument()
    expect(origin().className).toMatch(/border-red-400/)
  })

  it('sends just the origin text to the API (no mode)', async () => {
    resolvePoint.mockResolvedValue({ lon: -110.55, lat: 45.25 })
    render(<App />)
    const user = userEvent.setup()
    await user.type(origin(), '45.25N, 110.55W')
    await user.tab()
    await waitFor(() => expect(resolvePoint).toHaveBeenCalled())
    expect(resolvePoint).toHaveBeenCalledWith('45.25N, 110.55W')
  })
})

describe('pick origin on the map', () => {
  it('the button arms the map; a click writes decimal degrees, moves the marker and checks elevation', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ preflightStatus: 'valid', demPath: '/x.tif' }))
    originElevation.mockResolvedValue({ within_bounds: true, elevation: 321, reason: null })
    render(<App />)
    const user = userEvent.setup()
    expect(mapProps.originPicking.active).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Pick on map' }))
    expect(mapProps.originPicking.active).toBe(true)
    expect(screen.getByRole('button', { name: 'Pick on map' })).toHaveAttribute('aria-pressed', 'true')

    act(() => mapProps.originPicking.onPick({ lon: -110.55, lat: 45.25 }))
    expect(origin()).toHaveValue('45.25000N, 110.55000W')
    expect(mapProps.mapData.origin).toEqual([-110.55, 45.25])
    expect(mapProps.originPicking.active).toBe(false) // one click, then disarmed
    // No resolve round trip: the click already is lon/lat.
    expect(resolvePoint).not.toHaveBeenCalled()
  })

  it('Cancel / Escape (onExit) disarms without changing the origin', async () => {
    render(<App />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Pick on map' }))
    act(() => mapProps.originPicking.onExit())
    expect(mapProps.originPicking.active).toBe(false)
    expect(origin()).toHaveValue('')
  })

  it('switching modes disarms an armed pick', async () => {
    render(<App />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Pick on map' }))
    await user.click(screen.getByRole('button', { name: 'Advanced' }))
    expect(mapProps.originPicking.active).toBe(false)
  })
})

describe('older saves', () => {
  it('a save made in a non-decimal origin mode drops the value that no longer parses', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ originMode: 'epsg', originEpsg: 'EPSG:32612', originValue: '500000,5000000' })
    )
    render(<App />)
    expect(origin()).toHaveValue('')
  })

  it('a decimal-degrees save keeps its value', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ originMode: 'decimal_degrees', originValue: '45N, 110W' }))
    render(<App />)
    expect(origin()).toHaveValue('45N, 110W')
  })
})

describe('required-field outlines replace the footer list', () => {
  it('the footer only points at the highlighted fields', () => {
    render(<App />)
    expect(screen.queryByText(/Still needed/)).not.toBeInTheDocument()
    expect(screen.getByText('Complete the highlighted fields to run.')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Azimuth (deg)').className).toMatch(/border-blue-400/)
    expect(screen.getByPlaceholderText('Tilt (m/km)').className).toMatch(/border-blue-400/)
    expect(screen.getByPlaceholderText('Target elev. (m)').className).toMatch(/border-blue-400/)
  })

  it('a filled tilt field turns green; the optional radius stays plain until filled', async () => {
    render(<App />)
    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText('Azimuth (deg)'), '90')
    expect(screen.getByPlaceholderText('Azimuth (deg)').className).toMatch(/border-green-500/)
    expect(screen.getByPlaceholderText('No limit').className).toMatch(/border-gray-300/)
    await user.type(screen.getByPlaceholderText('No limit'), '50')
    expect(screen.getByPlaceholderText('No limit').className).toMatch(/border-green-500/)
  })

  it('the target elevation field always has its label, including when derived from the DEM', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ preflightStatus: 'valid', demPath: '/x.tif' }))
    originElevation.mockResolvedValue({ within_bounds: true, elevation: 245, reason: null })
    resolvePoint.mockResolvedValue({ lon: -110.55, lat: 45.25 })
    render(<App />)
    const user = userEvent.setup()
    await user.type(origin(), '45.25N, 110.55W')
    await user.tab()
    expect(await screen.findByText('245 m — from DEM at origin')).toBeInTheDocument()
    expect(screen.getByLabelText('Target elevation (m)')).toBeDisabled()
  })
})

// The order fields are filled in mustn't matter: an origin committed while the
// DEM's preflight is still in flight gets its elevation checked once the DEM is
// ready, and Run is never disabled behind an all-green form.
describe('origin entered before the DEM preflight resolves', () => {
  const runButton = () => screen.getByRole('button', { name: 'Run model' })
  const targetInput = () => screen.getByPlaceholderText('Target elev. (m)')

  async function enterOriginBeforePreflight() {
    let finishPreflight
    runPreflight.mockReturnValue(new Promise((res) => (finishPreflight = res)))
    rasterPreview.mockRejectedValue(new Error('no preview in tests'))
    resolvePoint.mockResolvedValue({ lon: -104.85, lat: 44.85 })
    render(<App />)
    const user = userEvent.setup()
    await user.type(screen.getByPlaceholderText('/path/to/dem.tif'), '/data/dem.tif')
    await user.tab()
    await user.type(origin(), '44.85N, 104.85W')
    await user.tab()
    expect(await screen.findByText('Origin located.')).toBeInTheDocument()
    // No DEM yet: nothing to check the elevation against.
    expect(originElevation).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText('Azimuth (deg)'), '30')
    await user.type(screen.getByLabelText('Tilt (m/km)'), '0.5')
    return { user, finishPreflight }
  }

  it('checks the elevation once preflight succeeds and fills the target from the DEM', async () => {
    originElevation.mockResolvedValue({ within_bounds: true, elevation: 1234.5, reason: null })
    const { finishPreflight } = await enterOriginBeforePreflight()
    expect(runButton()).toBeDisabled()

    await act(async () => finishPreflight({ crs: 'EPSG:4326', bounds_wgs84: [-105, 44, -104, 45] }))
    await waitFor(() => expect(originElevation).toHaveBeenCalledWith(null, '/data/dem.tif', '44.85N, 104.85W'))
    expect(await screen.findByText(/1234.5 m — from DEM at origin/)).toBeInTheDocument()
    await waitFor(() => expect(runButton()).toBeEnabled())
  })

  it('outside the DEM, a typed target elevation is enough to run', async () => {
    originElevation.mockResolvedValue({ within_bounds: false, elevation: null, reason: 'outside_bounds' })
    const { user, finishPreflight } = await enterOriginBeforePreflight()
    await act(async () => finishPreflight({ crs: 'EPSG:4326', bounds_wgs84: [-105, 44, -104, 45] }))
    expect(await screen.findByText(/Origin falls outside the DEM/)).toBeInTheDocument()
    await user.type(targetInput(), '1500')
    expect(targetInput().className).toMatch(/border-green-500/)
    expect(runButton()).toBeEnabled()
  })

  it('a failed elevation preview leaves a hand-entered target usable, with a message', async () => {
    originElevation.mockRejectedValue(new Error('boom'))
    const { user, finishPreflight } = await enterOriginBeforePreflight()
    await act(async () => finishPreflight({ crs: 'EPSG:4326', bounds_wgs84: [-105, 44, -104, 45] }))
    expect(await screen.findByText(/Could not read the DEM elevation at the origin/)).toBeInTheDocument()
    await user.type(targetInput(), '1500')
    expect(runButton()).toBeEnabled()
  })

  it('an origin typed but not yet looked up is blue and says what to do', async () => {
    render(<App />)
    const user = userEvent.setup()
    await user.type(origin(), '44.85N, 104.85W')
    expect(origin().className).toMatch(/border-blue-400/)
    expect(screen.getByText('Click out of the field to look up this coordinate.')).toBeInTheDocument()
  })

  it('a stale elevation answer for an edited origin is dropped', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ preflightStatus: 'valid', demPath: '/x.tif' }))
    let finish
    originElevation.mockReturnValue(new Promise((res) => (finish = res)))
    resolvePoint.mockResolvedValue({ lon: -104.85, lat: 44.85 })
    render(<App />)
    const user = userEvent.setup()
    await user.type(origin(), '44.85N, 104.85W')
    await user.tab()
    await user.type(origin(), '1') // edits the origin while the check is in flight
    await act(async () => finish({ within_bounds: true, elevation: 999, reason: null }))
    expect(screen.queryByText(/999 m — from DEM at origin/)).not.toBeInTheDocument()
  })
})
