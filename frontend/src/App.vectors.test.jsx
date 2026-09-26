// End-to-end wiring of the vectors direction source at the App level: the map's
// editing callbacks -> state -> table, and the map data App hands MapPanel.
// MapPanel is mocked (its Leaflet behavior is covered in VectorLayer.test.js).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
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
import { upliftPreview } from './api/client.js'

const STORAGE_KEY = 'gia-tool:last-run'

// Boots the App in Advanced mode with the vectors source, with DEM bounds and an
// origin already "resolved" (as the preflight / resolve-point calls would leave them).
async function bootVectors(extra = {}) {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      mode: 'advanced',
      tiltFactor: '0.35',
      advanced: {
        sectionsOpen: { dem: false, origin: false, tilt: true, output: false },
        directionSource: 'vectors',
        vectors: []
      },
      ...extra
    })
  )
  const view = render(<App />)
  return view
}

beforeEach(() => {
  window.localStorage.clear()
  mapProps = null
  vi.clearAllMocks()
  upliftPreview.mockResolvedValue({ isobases: { type: 'FeatureCollection', features: [] }, vectors: [], warnings: [] })
})

describe('App in vectors mode', () => {
  it('hands the map an editing contract and no azimuth line; the compass rose has no single azimuth', async () => {
    bootVectors({ tiltAzimuth: '45' })
    expect(mapProps.editing).toMatchObject({ mode: 'none' })
    expect(typeof mapProps.editing.onAddVector).toBe('function')
    expect(mapProps.mapData.azimuthLine).toBeNull()
    expect(mapProps.azimuthDeg).toBe('')
    expect(mapProps.mapData.vectors).toBeNull() // no vectors yet: the empty-map hint still shows
  })

  it('a drag-added vector lands in the table with its azimuth and range, selected, and undoable', async () => {
    const user = userEvent.setup()
    bootVectors()
    act(() => mapProps.editing.onAddVector({ lon: -104.123456, lat: 45.987654, azimuthDeg: 28.04, rangeKm: 12.34 }))

    expect(screen.getByLabelText('Vector 1 latitude')).toHaveValue('45.98765')
    expect(screen.getByLabelText('Vector 1 longitude')).toHaveValue('-104.12346')
    expect(screen.getByLabelText('Vector 1 azimuth')).toHaveValue('28.0')
    expect(screen.getByLabelText('Vector 1 range (km)')).toHaveValue('12.3')
    expect(mapProps.mapData.vectors).toHaveLength(1)
    expect(mapProps.mapData.vectors[0]).toMatchObject({ number: 1, azimuthDeg: 28, rangeKm: 12.3, selected: true, custom: false })

    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.queryByLabelText('Vector 1 latitude')).not.toBeInTheDocument()
  })

  it('a click-added vector has no azimuth yet, and the table focuses that input', async () => {
    bootVectors()
    act(() => mapProps.editing.onAddVector({ lon: -104, lat: 45, azimuthDeg: null, rangeKm: null }))
    expect(screen.getByLabelText('Vector 1 azimuth')).toHaveValue('')
    expect(screen.getByLabelText('Vector 1 azimuth')).toHaveFocus()
    expect(mapProps.mapData.vectors[0].azimuthDeg).toBeNull()
  })

  it('a click-added vector opens a collapsed Tilt model section to take focus', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        mode: 'advanced',
        advanced: { sectionsOpen: { dem: false, origin: false, tilt: false, output: false }, directionSource: 'vectors' }
      })
    )
    render(<App />)
    expect(screen.queryByRole('button', { name: '+ Add row' })).not.toBeInTheDocument()
    act(() => mapProps.editing.onAddVector({ lon: -104, lat: 45, azimuthDeg: null, rangeKm: null }))
    expect(await screen.findByLabelText('Vector 1 azimuth')).toBeInTheDocument()
  })

  it('a map drag updates only the fields it changed, as one undo step', async () => {
    const user = userEvent.setup()
    bootVectors()
    act(() => mapProps.editing.onAddVector({ lon: -104, lat: 45, azimuthDeg: 90, rangeKm: 30 }))
    const id = mapProps.mapData.vectors[0].id

    act(() => mapProps.editing.onUpdateVector(id, { lon: -103.5, lat: 45.5 })) // base handle
    expect(screen.getByLabelText('Vector 1 longitude')).toHaveValue('-103.50000')
    expect(screen.getByLabelText('Vector 1 azimuth')).toHaveValue('90.0') // untouched

    act(() => mapProps.editing.onUpdateVector(id, { azimuthDeg: 200, rangeKm: 55 })) // tip handle
    expect(screen.getByLabelText('Vector 1 azimuth')).toHaveValue('200.0')
    expect(screen.getByLabelText('Vector 1 range (km)')).toHaveValue('55.0')
    expect(screen.getByLabelText('Vector 1 longitude')).toHaveValue('-103.50000') // untouched

    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByLabelText('Vector 1 azimuth')).toHaveValue('90.0')
    expect(screen.getByLabelText('Vector 1 longitude')).toHaveValue('-103.50000')
  })

  it('selecting on the map selects the table row, and the arrow reflects a table selection', async () => {
    const user = userEvent.setup()
    bootVectors()
    act(() => mapProps.editing.onAddVector({ lon: -104, lat: 45, azimuthDeg: 90, rangeKm: 30 }))
    act(() => mapProps.editing.onAddVector({ lon: -103, lat: 46, azimuthDeg: 10, rangeKm: 30 }))
    const [a, b] = mapProps.mapData.vectors.map((v) => v.id)
    expect(mapProps.mapData.vectors.map((v) => v.selected)).toEqual([false, true]) // the last add is selected

    act(() => mapProps.editing.onSelectVector(a))
    expect(document.getElementById(`vector-row-${a}`)).toHaveAttribute('aria-selected', 'true')
    expect(mapProps.mapData.vectors.map((v) => v.selected)).toEqual([true, false])

    await user.click(screen.getByLabelText('Vector 2 latitude'))
    expect(mapProps.mapData.vectors.map((v) => v.selected)).toEqual([false, true])
    expect(document.getElementById(`vector-row-${b}`)).toHaveAttribute('aria-selected', 'true')
  })

  it('Add on map arms the map, and the map\'s Done/Escape callback disarms it', async () => {
    const user = userEvent.setup()
    bootVectors()
    await user.click(screen.getByRole('button', { name: 'Add on map' }))
    expect(mapProps.editing.mode).toBe('addVector')
    act(() => mapProps.editing.onExitAddMode())
    expect(mapProps.editing.mode).toBe('none')
    expect(screen.getByRole('button', { name: 'Add on map' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('the selection, edit mode and preview are not persisted; the vectors are', async () => {
    bootVectors()
    act(() => mapProps.editing.onAddVector({ lon: -104, lat: 45, azimuthDeg: 90, rangeKm: 30 }))
    act(() => mapProps.editing.onExitAddMode())
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY))
    expect(stored.advanced.vectors).toHaveLength(1)
    expect(stored).not.toHaveProperty('selectedVectorId')
    expect(stored).not.toHaveProperty('mapEditMode')
    expect(stored).not.toHaveProperty('upliftPreview')
  })
})

describe('App in the other modes', () => {
  it('Basic mode: no editing contract, no vectors, the azimuth line as before', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ mode: 'basic', tiltAzimuth: '45', advanced: { directionSource: 'vectors', vectors: [{ lat: '45', lon: '-105', azimuthDeg: '10' }] } })
    )
    render(<App />)
    expect(mapProps.editing).toBeUndefined()
    expect(mapProps.mapData.vectors).toBeNull()
    expect(mapProps.azimuthDeg).toBe('45')
  })

  it('Advanced with the azimuth source: no editing contract', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: 'advanced', tiltAzimuth: '45' }))
    render(<App />)
    expect(mapProps.editing).toBeUndefined()
    expect(mapProps.azimuthDeg).toBe('45')
  })

  it('switching to Basic disarms an armed Add on map', async () => {
    const user = userEvent.setup()
    bootVectors()
    await user.click(screen.getByRole('button', { name: 'Add on map' }))
    await user.click(screen.getByRole('button', { name: 'Basic' }))
    await user.click(screen.getByRole('button', { name: 'Advanced' }))
    expect(mapProps.editing.mode).toBe('none')
  })
})
