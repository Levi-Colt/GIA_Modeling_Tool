// Click-to-place origin on a real (jsdom) Leaflet map through MapPanel itself:
// armed by `originPicking.active`, one click reports lon/lat, Escape and Cancel
// exit, and nothing is bound while it is off. The raster library is stubbed.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('georaster-layer-for-leaflet', () => ({ default: class {} }))

import MapPanel from './MapPanel.jsx'

const container = (root) => root.querySelector('.leaflet-container')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('originPicking', () => {
  it('does nothing while inactive: a click reports nothing and the cursor is untouched', () => {
    const onPick = vi.fn()
    const { container: root } = render(<MapPanel mapData={{}} originPicking={{ active: false, onPick, onExit: vi.fn() }} />)
    fireEvent.click(container(root))
    expect(onPick).not.toHaveBeenCalled()
    expect(container(root).style.cursor).toBe('')
    expect(screen.queryByText(/Click the map to set the spillway origin/)).not.toBeInTheDocument()
  })

  it('while active, shows the hint, a crosshair cursor, and reports a click as finite lon/lat', () => {
    const onPick = vi.fn()
    const { container: root } = render(<MapPanel mapData={{}} originPicking={{ active: true, onPick, onExit: vi.fn() }} />)
    expect(screen.getByText(/Click the map to set the spillway origin/)).toBeInTheDocument()
    expect(container(root).style.cursor).toBe('crosshair')

    fireEvent.click(container(root))
    expect(onPick).toHaveBeenCalledTimes(1)
    const { lon, lat } = onPick.mock.calls[0][0]
    expect(Number.isFinite(lon)).toBe(true)
    expect(Number.isFinite(lat)).toBe(true)
  })

  it('Escape and the Cancel button both exit', () => {
    const onExit = vi.fn()
    render(<MapPanel mapData={{}} originPicking={{ active: true, onPick: vi.fn(), onExit }} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onExit).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onExit).toHaveBeenCalledTimes(2)
  })

  it('disarming removes the crosshair and stops listening', () => {
    const onPick = vi.fn()
    const onExit = vi.fn()
    const { container: root, rerender } = render(
      <MapPanel mapData={{}} originPicking={{ active: true, onPick, onExit }} />
    )
    rerender(<MapPanel mapData={{}} originPicking={{ active: false, onPick, onExit }} />)
    expect(container(root).style.cursor).toBe('')
    fireEvent.click(container(root))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onPick).not.toHaveBeenCalled()
    expect(onExit).not.toHaveBeenCalled()
  })
})
