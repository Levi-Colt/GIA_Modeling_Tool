// Wiring of the shore-points direction source at the App level: the map data App
// hands MapPanel (points colored by the fit that answers them, isobases, hull), and
// nothing from the other direction sources. MapPanel is mocked; its Leaflet drawing
// is checked in MapPanel.shorePoints.test.jsx.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

let mapProps
vi.mock('./components/map/MapPanel.jsx', () => ({
  default: (props) => {
    mapProps = props
    return <div data-testid="map" />
  }
}))
vi.mock('./api/client.js', () => ({
  fitUpliftSurface: vi.fn(),
  upliftPreview: vi.fn(),
  profilePreview: vi.fn().mockResolvedValue({}),
  runPreflight: vi.fn(),
  rasterPreview: vi.fn(),
  resolvePoint: vi.fn(),
  originElevation: vi.fn(),
  runProcess: vi.fn()
}))

import App from './App.jsx'
import { fitUpliftSurface } from './api/client.js'

const STORAGE_KEY = 'gia-tool:last-run'

const rows = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `p${i}`, lat: String(45 + i / 100), lon: String(-105 + i / 100), elevationM: String(300 + i), label: `S${i}`
  }))

const RESIDUALS = [1, -2, 3, -4, 5, -6, 7, -8, 20]
const RESPONSE = {
  orders: [{ order: 2, n: 9, terms: 6, r2: 0.99, adj_r2: 0.98, rmse_m: 1 }],
  selected: {
    order: 2, n: 9, terms: 6, r2: 0.99, adj_r2: 0.98, rmse_m: 1, cond: 3,
    residuals_m: RESIDUALS, std_residuals: RESIDUALS, outlier_indices: [8]
  },
  isobases: {
    inside: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { elevation_m: 310 }, geometry: { type: 'LineString', coordinates: [[-105, 45], [-104.9, 45.1]] } }] },
    outside: { type: 'FeatureCollection', features: [] }
  },
  interval_m: 10,
  hull: { type: 'Polygon', coordinates: [[[-105, 45], [-104.9, 45], [-104.9, 45.1], [-105, 45]]] },
  dem_fraction_outside_hull: 0.1,
  origin_inside_hull: true,
  warnings: []
}

// Advanced mode, shore-points source, with the DEM bounds and origin as the preflight
// and resolve-point calls would have left them (transient keys load if present).
function boot(advanced = {}, extra = {}) {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      mode: 'advanced',
      tiltAzimuth: '45',
      tiltFactor: '0.35',
      boundsWgs84: [-106, 44, -104, 46],
      resolvedOrigin: [-104.95, 45.05],
      advanced: {
        sectionsOpen: { dem: false, origin: false, tilt: true, output: false },
        directionSource: 'points',
        shorePoints: rows(9),
        ...advanced
      },
      ...extra
    })
  )
  return render(<App />)
}

beforeEach(() => {
  window.localStorage.clear()
  mapProps = null
  vi.clearAllMocks()
  fitUpliftSurface.mockResolvedValue(RESPONSE)
})

describe('App in shore-points mode', () => {
  it('hands the map the points, neutral until the fit answers, then colored data, isobases and hull', async () => {
    boot()
    expect(mapProps.mapData.shorePoints).toHaveLength(9)
    expect(mapProps.mapData.shorePoints.every((p) => p.residualM === null)).toBe(true)
    expect(mapProps.mapData.surfaceIsobases).toBeNull()

    await waitFor(() => expect(mapProps.mapData.surfaceIsobases).toEqual(RESPONSE.isobases), { timeout: 3000 })
    expect(mapProps.mapData.dataHull).toEqual(RESPONSE.hull)
    expect(mapProps.mapData.shorePoints.map((p) => p.residualM)).toEqual(RESIDUALS)
    expect(mapProps.mapData.shorePoints.map((p) => p.outlier)).toEqual([false, false, false, false, false, false, false, false, true])
    expect(mapProps.mapData.shorePoints[0]).toMatchObject({ id: 'p0', label: 'S0', elevationM: 300 })
    expect(fitUpliftSurface).toHaveBeenCalledTimes(1)
  })

  it('has no azimuth line, no compass azimuth, no vectors and no vector isobases; the map is display-only', () => {
    boot()
    expect(mapProps.mapData.azimuthLine).toBeNull()
    expect(mapProps.azimuthDeg).toBe('')
    expect(mapProps.mapData.vectors).toBeNull()
    expect(mapProps.mapData.isobases).toBeNull()
    expect(mapProps.editing).toBeUndefined()
  })

  it('draws no points when the source is a single azimuth, whatever points are stored', () => {
    boot({ directionSource: 'azimuth' })
    expect(mapProps.mapData.shorePoints).toBeNull()
    expect(mapProps.mapData.surfaceIsobases).toBeNull()
    expect(mapProps.mapData.dataHull).toBeNull()
    expect(mapProps.mapData.azimuthLine).not.toBeNull()
    expect(fitUpliftSurface).not.toHaveBeenCalled()
  })

  it('the tilt section shows the points summary and needs no azimuth or gradient', () => {
    boot({}, { tiltAzimuth: '', tiltFactor: '' })
    expect(screen.getByText('9 points')).toBeInTheDocument()
    expect(screen.getByText(/9 shore points · order 2/)).toBeInTheDocument()
    expect(screen.queryByText(/Needs:.*tilt azimuth/)).not.toBeInTheDocument()
  })
})
