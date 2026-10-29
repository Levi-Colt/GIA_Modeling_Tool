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
import { originElevation, resolvePoint } from './api/client.js'

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
