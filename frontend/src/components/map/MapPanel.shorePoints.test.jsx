// The shore-points layers on a real (jsdom) Leaflet map through MapPanel itself:
// residual-colored points, the surface isobases (solid inside the hull, dashed
// outside, labelled in absolute meters), the hull outline, the legend, and the
// layer order. The raster library is stubbed (it is not what is under test).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'

vi.mock('georaster-layer-for-leaflet', () => ({ default: class {} }))

import MapPanel from './MapPanel.jsx'
import { RESIDUAL_NEGATIVE, RESIDUAL_POSITIVE, RESIDUAL_UNKNOWN, RESIDUAL_ZERO } from '../../utils/colors.js'

const point = (patch = {}) => ({
  id: 'a', lon: -105, lat: 45, elevationM: 331.4, residualM: 0, outlier: false, label: 'Pit 7', ...patch
})

const line = (elevation, coords) => ({
  type: 'Feature',
  properties: { elevation_m: elevation },
  geometry: { type: 'LineString', coordinates: coords }
})
const collection = (...features) => ({ type: 'FeatureCollection', features })

const ISOBASES = {
  inside: collection(line(310, [[-105, 45], [-104.9, 45.1]]), line(320, [[-105, 45.05], [-104.9, 45.15]])),
  outside: collection(line(330, [[-104.8, 45], [-104.7, 45.1]]))
}
const HULL = { type: 'Polygon', coordinates: [[[-105.1, 44.9], [-104.7, 44.9], [-104.7, 45.3], [-105.1, 45.3], [-105.1, 44.9]]] }

const pane = (container, name) => container.querySelector(`.leaflet-${name}-pane`)
const paths = (container, name) => Array.from(pane(container, name)?.querySelectorAll('path') ?? [])

beforeEach(() => {
  vi.clearAllMocks()
})

describe('shore points', () => {
  it('draws one circle per point in its own pane, colored on the diverging scale by residual', () => {
    const { container } = render(
      <MapPanel
        mapData={{
          shorePoints: [
            point({ id: 'a', residualM: -8 }),
            point({ id: 'b', lon: -104.9, residualM: 0 }),
            point({ id: 'c', lon: -104.8, residualM: 8 }),
            point({ id: 'd', lon: -104.7, residualM: null })
          ]
        }}
      />
    )
    const fills = paths(container, 'points').map((p) => p.getAttribute('fill'))
    expect(fills).toEqual([RESIDUAL_NEGATIVE, RESIDUAL_ZERO, RESIDUAL_POSITIVE, RESIDUAL_UNKNOWN])
  })

  it('gives possible outliers a heavier dark ring and draws them last (on top)', () => {
    const { container } = render(
      <MapPanel
        mapData={{ shorePoints: [point({ id: 'a', outlier: true, residualM: 9 }), point({ id: 'b', lon: -104.9, residualM: 1 })] }}
      />
    )
    const [first, second] = paths(container, 'points')
    expect(Number(first.getAttribute('stroke-width'))).toBe(1) // the ordinary point drawn first
    expect(Number(second.getAttribute('stroke-width'))).toBe(3) // the outlier, last
    expect(second.getAttribute('stroke')).toBe('#111827')
  })

  it('shows the site, elevation and residual in a tooltip, built as text (a label is never HTML)', () => {
    const { container } = render(
      <MapPanel mapData={{ shorePoints: [point({ label: '<img src=x onerror=alert(1)>', residualM: -2.5, outlier: true })] }} />
    )
    fireEvent.mouseOver(paths(container, 'points')[0])
    const tip = container.querySelector('.leaflet-tooltip')
    expect(tip).not.toBeNull()
    expect(tip).toHaveTextContent('<img src=x onerror=alert(1)>')
    expect(tip).toHaveTextContent('331.4 m elevation')
    expect(tip).toHaveTextContent('residual −2.50 m (possible outlier)')
    expect(tip.querySelector('img')).toBeNull()
  })

  it('says the residual is not fitted yet before the fit answers', () => {
    const { container } = render(<MapPanel mapData={{ shorePoints: [point({ residualM: null })] }} />)
    fireEvent.mouseOver(paths(container, 'points')[0])
    expect(container.querySelector('.leaflet-tooltip')).toHaveTextContent('residual: not fitted yet')
  })
})

describe('residual legend', () => {
  it('shows a symmetric scale with the largest residual, in the map chrome', () => {
    render(<MapPanel mapData={{ shorePoints: [point({ residualM: -3.2 }), point({ id: 'b', residualM: 7.4 })] }} />)
    const legend = screen.getByRole('group', { name: 'Residual legend' })
    expect(within(legend).getByText('Residual (m)')).toBeInTheDocument()
    expect(within(legend).getByText('−7.4')).toBeInTheDocument()
    expect(within(legend).getByText('+7.4')).toBeInTheDocument()
    expect(within(legend).getByText('0')).toBeInTheDocument()
  })

  it('is absent without shore points, and without any residual yet', () => {
    const { rerender } = render(<MapPanel mapData={{ extent: [-106, 44, -104, 46] }} />)
    expect(screen.queryByRole('group', { name: 'Residual legend' })).not.toBeInTheDocument()
    rerender(<MapPanel mapData={{ shorePoints: [point({ residualM: null })] }} />)
    expect(screen.queryByRole('group', { name: 'Residual legend' })).not.toBeInTheDocument()
  })
})

describe('surface isobases and hull', () => {
  it('draws inside isobases solid and outside ones dashed, each labelled in absolute meters', () => {
    const { container } = render(<MapPanel mapData={{ surfaceIsobases: ISOBASES }} />)
    const lines = paths(container, 'isobases')
    expect(lines).toHaveLength(3)
    const dashed = lines.filter((p) => p.getAttribute('stroke-dasharray'))
    expect(dashed).toHaveLength(1)
    expect(dashed[0].getAttribute('stroke-dasharray')).toBe('5 5')

    const labels = Array.from(pane(container, 'isobases').querySelectorAll('span')).map((s) => s.textContent)
    expect(labels.sort()).toEqual(['310 m', '320 m', '330 m'])
  })

  it('draws the hull as a thin dashed outline in its own pane', () => {
    const { container } = render(<MapPanel mapData={{ dataHull: HULL }} />)
    const [outline] = paths(container, 'hull')
    expect(outline).toBeDefined()
    expect(outline.getAttribute('stroke-dasharray')).toBeTruthy()
    expect(Number(outline.getAttribute('stroke-width'))).toBeLessThanOrEqual(1)
    expect(outline.getAttribute('fill')).toBe('none')
  })

  it('removes the layers when the data go away', () => {
    const { container, rerender } = render(
      <MapPanel mapData={{ shorePoints: [point()], surfaceIsobases: ISOBASES, dataHull: HULL }} />
    )
    expect(paths(container, 'points')).toHaveLength(1)
    rerender(<MapPanel mapData={{ extent: [-106, 44, -104, 46] }} />)
    expect(paths(container, 'points')).toHaveLength(0)
    expect(paths(container, 'isobases')).toHaveLength(0)
    expect(paths(container, 'hull')).toHaveLength(0)
  })
})

describe('layer order', () => {
  it('stacks radius -> hull -> isobases -> contour -> points -> origin', () => {
    const { container } = render(<MapPanel mapData={{ shorePoints: [point()], surfaceIsobases: ISOBASES, dataHull: HULL }} />)
    const z = (name) => Number(pane(container, name).style.zIndex)
    expect(z('radius')).toBeLessThan(z('hull'))
    expect(z('hull')).toBeLessThan(z('isobases'))
    expect(z('isobases')).toBeLessThan(z('contour'))
    expect(z('contour')).toBeLessThan(z('points'))
    expect(z('points')).toBeLessThan(z('origin'))
    expect(z('vectors')).toBeLessThan(z('origin'))
  })
})
