// Vector arrows and editing gestures on a real (jsdom) Leaflet map. MapPanel
// itself is not mounted here (it pulls in the raster layer library); this covers
// the whole editing contract: rendering, drag-end callbacks, add-on-map.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import L from 'leaflet'
import { createVectorLayer } from './VectorLayer.js'
import { bearingDeg, distanceKm, pointAlong } from '../../utils/geometry.js'

let container
let map
let layer

const base = { id: 'a', number: 1, lon: -105, lat: 45, azimuthDeg: 90, rangeKm: 40, lengthKm: 40, selected: false, custom: false }
const second = { id: 'b', number: 2, lon: -104.5, lat: 45.2, azimuthDeg: 0, rangeKm: null, lengthKm: 20, selected: false, custom: true }

function callbacks() {
  return {
    mode: 'none',
    onAddVector: vi.fn(),
    onUpdateVector: vi.fn(),
    onSelectVector: vi.fn(),
    onExitAddMode: vi.fn()
  }
}

const layersOf = (Type) => {
  const found = []
  map.eachLayer((l) => l instanceof Type && found.push(l))
  return found
}
// Non-filled polylines only (the base map has none; polygons extend polylines).
const shafts = () => layersOf(L.Polyline).filter((l) => !(l instanceof L.Polygon))
const heads = () => layersOf(L.Polygon)
const markers = () => layersOf(L.Marker)
const baseMarker = (n) => markers().find((m) => m.options.icon.options.html.includes(`>${n}</div>`))
const tipMarkers = () => markers().filter((m) => m.options.icon.options.html.includes('rotate(45deg)'))

beforeEach(() => {
  container = document.createElement('div')
  Object.defineProperty(container, 'clientWidth', { value: 600, configurable: true })
  Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true })
  document.body.appendChild(container)
  map = L.map(container).setView([45, -105], 8)
  map.createPane('vectors')
  layer = createVectorLayer(map, { pane: 'vectors', container })
})

afterEach(() => {
  layer.destroy()
  map.remove()
  container.remove()
})

describe('rendering', () => {
  it('draws a shaft, a head, a tip handle and a numbered base handle per vector with an azimuth', () => {
    layer.render([base], callbacks())
    expect(shafts()).toHaveLength(1)
    expect(heads()).toHaveLength(1)
    expect(tipMarkers()).toHaveLength(1)
    expect(baseMarker(1)).toBeDefined()

    const [shaft] = shafts()
    const [from, to] = shaft.getLatLngs()
    expect([from.lng, from.lat]).toEqual([-105, 45])
    expect(distanceKm([from.lng, from.lat], [to.lng, to.lat])).toBeCloseTo(40, 2)
    expect(bearingDeg([from.lng, from.lat], [to.lng, to.lat])).toBeCloseTo(90, 1)
  })

  it('a vector with no azimuth yet (click-added) draws only its base handle', () => {
    layer.render([{ ...base, azimuthDeg: null, rangeKm: null }], callbacks())
    expect(shafts()).toHaveLength(0)
    expect(heads()).toHaveLength(0)
    expect(tipMarkers()).toHaveLength(0)
    expect(baseMarker(1)).toBeDefined()
  })

  it('custom-tilt vectors get a filled head, global ones a hollow one', () => {
    layer.render([base, second], callbacks())
    const [globalHead, customHead] = heads()
    expect(globalHead.options.fill).toBe(false)
    expect(customHead.options.fill).toBe(true)
    expect(customHead.options.fillOpacity).toBe(1)
  })

  it('the selected vector is thicker and in the accent color', () => {
    layer.render([{ ...base, selected: true }, second], callbacks())
    const [selectedShaft, plainShaft] = shafts()
    expect(selectedShaft.options.weight).toBeGreaterThan(plainShaft.options.weight)
    expect(selectedShaft.options.color).not.toBe(plainShaft.options.color)
  })

  it('labels each base handle with its table row number', () => {
    layer.render([base, second], callbacks())
    expect(baseMarker(1)).toBeDefined()
    expect(baseMarker(2)).toBeDefined()
  })

  it('handles are keyboard-inert (the table is the keyboard path) and draggable', () => {
    layer.render([base], callbacks())
    expect(baseMarker(1).options.keyboard).toBe(false)
    expect(baseMarker(1).options.draggable).toBe(true)
    expect(tipMarkers()[0].options.keyboard).toBe(false)
    expect(tipMarkers()[0].options.draggable).toBe(true)
  })

  it('without editing (the results view) the arrows are display-only: no tip, no dragging', () => {
    layer.render([base], undefined)
    expect(shafts()).toHaveLength(1)
    expect(tipMarkers()).toHaveLength(0)
    expect(baseMarker(1).options.draggable).toBe(false)
    expect(baseMarker(1).options.interactive).toBe(false)
  })

  it('re-rendering replaces the arrows rather than stacking them', () => {
    layer.render([base, second], callbacks())
    layer.render([base], callbacks())
    expect(shafts()).toHaveLength(1)
    expect(markers()).toHaveLength(2) // one base + one tip
  })

  it('destroy removes everything', () => {
    layer.render([base, second], callbacks())
    layer.destroy()
    expect(shafts()).toHaveLength(0)
    expect(markers()).toHaveLength(0)
    layer = createVectorLayer(map, { pane: 'vectors', container }) // so afterEach can destroy again
  })
})

describe('editing existing vectors', () => {
  it('dragging the base handle moves the arrow live and commits once, on drag end', () => {
    const cb = callbacks()
    layer.render([base], cb)
    const handle = baseMarker(1)
    const [shaft] = shafts()

    handle.setLatLng([45.3, -104.6])
    handle.fire('drag')
    // Live update of the same arrow (same azimuth and length); nothing committed yet.
    const [from, to] = shaft.getLatLngs()
    expect(from.lat).toBeCloseTo(45.3, 6)
    expect(from.lng).toBeCloseTo(-104.6, 6)
    expect(distanceKm([from.lng, from.lat], [to.lng, to.lat])).toBeCloseTo(40, 2) // same length
    expect(bearingDeg([from.lng, from.lat], [to.lng, to.lat])).toBeCloseTo(90, 1) // same azimuth
    expect(cb.onUpdateVector).not.toHaveBeenCalled()

    handle.fire('dragend')
    expect(cb.onUpdateVector).toHaveBeenCalledTimes(1)
    const [id, patch] = cb.onUpdateVector.mock.calls[0]
    expect(id).toBe('a')
    expect(patch.lat).toBeCloseTo(45.3, 6)
    expect(patch.lon).toBeCloseTo(-104.6, 6)
    expect(patch).not.toHaveProperty('azimuthDeg') // moving does not rotate
    expect(cb.onSelectVector).toHaveBeenCalledWith('a')
  })

  it('dragging the tip handle rotates and resizes: azimuth and range commit on drag end', () => {
    const cb = callbacks()
    layer.render([base], cb)
    const tip = tipMarkers()[0]
    const target = pointAlong([-105, 45], 75, 200) // 75 km out at azimuth 200

    tip.setLatLng([target[1], target[0]])
    tip.fire('drag')
    expect(cb.onUpdateVector).not.toHaveBeenCalled() // commit on drag end only

    tip.fire('dragend')
    expect(cb.onUpdateVector).toHaveBeenCalledTimes(1)
    const [id, patch] = cb.onUpdateVector.mock.calls[0]
    expect(id).toBe('a')
    expect(patch.azimuthDeg).toBeCloseTo(200, 1)
    expect(patch.rangeKm).toBeCloseTo(75, 1)
    expect(patch).not.toHaveProperty('lat')
  })

  it('shows the azimuth and length while the tip is dragged', () => {
    layer.render([base], callbacks())
    const tip = tipMarkers()[0]
    const target = pointAlong([-105, 45], 12.5, 45)
    tip.setLatLng([target[1], target[0]])
    tip.fire('drag')
    expect(tip.getTooltip().getContent()).toBe('45° · 12.5 km')
  })

  it('a zero-length tip drag is ignored', () => {
    const cb = callbacks()
    layer.render([base], cb)
    const tip = tipMarkers()[0]
    tip.setLatLng([45, -105]) // onto the base point
    tip.fire('dragend')
    expect(cb.onUpdateVector).not.toHaveBeenCalled()
  })

  it('clicking an arrow or a handle selects it', () => {
    const cb = callbacks()
    layer.render([base, second], cb)
    shafts()[1].fire('click')
    expect(cb.onSelectVector).toHaveBeenLastCalledWith('b')
    baseMarker(1).fire('click')
    expect(cb.onSelectVector).toHaveBeenLastCalledWith('a')
    heads()[0].fire('click')
    expect(cb.onSelectVector).toHaveBeenLastCalledWith('a')
  })

  it('setEditing swaps in fresh callbacks without rebuilding, so a drag in progress survives a re-render', () => {
    const first = callbacks()
    layer.render([base], first)
    const handle = baseMarker(1)
    const second_ = callbacks()
    layer.setEditing(second_)
    expect(baseMarker(1)).toBe(handle) // same marker: nothing was rebuilt

    handle.setLatLng([45.1, -105.1])
    handle.fire('dragend')
    expect(first.onUpdateVector).not.toHaveBeenCalled()
    expect(second_.onUpdateVector).toHaveBeenCalledTimes(1)
  })
})

describe('add on map', () => {
  const press = (type, x, y, extra = {}) =>
    container.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, ...extra }))
  const startAdd = (cb = callbacks()) => {
    cb.mode = 'addVector'
    layer.render([], cb)
    return cb
  }

  it('shows a crosshair and disables panning, then restores both when switched off', () => {
    expect(map.dragging.enabled()).toBe(true)
    const cb = startAdd()
    expect(container.style.cursor).toBe('crosshair')
    expect(map.dragging.enabled()).toBe(false)

    layer.render([], { ...cb, mode: 'none' })
    expect(container.style.cursor).not.toBe('crosshair')
    expect(map.dragging.enabled()).toBe(true)
  })

  it('press, drag and release adds a vector with the dragged bearing and geodesic length', () => {
    const cb = startAdd()
    press('pointerdown', 300, 200)
    press('pointermove', 400, 200)
    press('pointerup', 500, 200) // 200 px to the east of the press point

    expect(cb.onAddVector).toHaveBeenCalledTimes(1)
    const { lon, lat, azimuthDeg, rangeKm } = cb.onAddVector.mock.calls[0][0]
    const start = map.containerPointToLatLng([300, 200])
    const end = map.containerPointToLatLng([500, 200])
    expect(lon).toBeCloseTo(start.lng, 8)
    expect(lat).toBeCloseTo(start.lat, 8)
    expect(azimuthDeg).toBeCloseTo(bearingDeg([start.lng, start.lat], [end.lng, end.lat]), 6)
    expect(azimuthDeg).toBeGreaterThan(85)
    expect(azimuthDeg).toBeLessThan(95)
    expect(rangeKm).toBeCloseTo(distanceKm([start.lng, start.lat], [end.lng, end.lat]), 6)
    expect(rangeKm).toBeGreaterThan(1)
  })

  it('shows a live preview arrow with an azimuth and length tooltip while dragging, and removes it on release', () => {
    startAdd()
    expect(shafts()).toHaveLength(0)
    press('pointerdown', 300, 200)
    press('pointermove', 420, 200)
    expect(layersOf(L.Tooltip)).toHaveLength(1)
    expect(layersOf(L.Tooltip)[0].getContent()).toMatch(/^\d+° · [\d.]+ km$/)
    expect(shafts()).toHaveLength(1) // the preview arrow

    press('pointerup', 420, 200)
    expect(layersOf(L.Tooltip)).toHaveLength(0)
    expect(shafts()).toHaveLength(0)
  })

  it('a drag under 8 px is a click: added with no azimuth or range', () => {
    const cb = startAdd()
    press('pointerdown', 300, 200)
    press('pointermove', 303, 202)
    press('pointerup', 304, 203)
    expect(cb.onAddVector).toHaveBeenCalledTimes(1)
    const arg = cb.onAddVector.mock.calls[0][0]
    expect(arg.azimuthDeg).toBeNull()
    expect(arg.rangeKm).toBeNull()
    expect(arg.lat).toBeCloseTo(map.containerPointToLatLng([300, 200]).lat, 8)
  })

  it('stays on for repeated adds', () => {
    const cb = startAdd()
    for (const x of [100, 200, 300]) {
      press('pointerdown', x, 100)
      press('pointerup', x + 60, 100)
    }
    expect(cb.onAddVector).toHaveBeenCalledTimes(3)
    expect(cb.onExitAddMode).not.toHaveBeenCalled()
    expect(map.dragging.enabled()).toBe(false)
  })

  it('Escape on the map container exits add mode; Escape on the window does not', () => {
    const cb = startAdd()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(cb.onExitAddMode).not.toHaveBeenCalled()

    container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(cb.onExitAddMode).toHaveBeenCalledTimes(1)
  })

  it('ignores presses on existing handles and map controls', () => {
    const cb = startAdd()
    const icon = document.createElement('div')
    icon.className = 'leaflet-marker-icon'
    container.appendChild(icon)
    icon.dispatchEvent(new MouseEvent('pointerdown', { clientX: 300, clientY: 200, button: 0, bubbles: true }))
    icon.dispatchEvent(new MouseEvent('pointerup', { clientX: 400, clientY: 200, button: 0, bubbles: true }))
    expect(cb.onAddVector).not.toHaveBeenCalled()
  })

  it('ignores non-primary buttons', () => {
    const cb = startAdd()
    press('pointerdown', 300, 200, { button: 2 })
    press('pointerup', 400, 200, { button: 2 })
    expect(cb.onAddVector).not.toHaveBeenCalled()
  })

  it('a cancelled gesture (pointercancel) adds nothing and clears the preview', () => {
    const cb = startAdd()
    press('pointerdown', 300, 200)
    press('pointermove', 400, 200)
    press('pointercancel', 400, 200)
    press('pointerup', 400, 200)
    expect(cb.onAddVector).not.toHaveBeenCalled()
    expect(layersOf(L.Tooltip)).toHaveLength(0)
  })

  it('stops adding once add mode is off, and destroy also restores panning', () => {
    const cb = startAdd()
    layer.render([], { ...cb, mode: 'none' })
    press('pointerdown', 300, 200)
    press('pointerup', 500, 200)
    expect(cb.onAddVector).not.toHaveBeenCalled()

    startAdd(cb)
    layer.destroy()
    expect(map.dragging.enabled()).toBe(true)
    layer = createVectorLayer(map, { pane: 'vectors', container })
  })
})
