import L from 'leaflet'
import { arrowGeometry, bearingDeg, distanceKm, isClick } from '../../utils/geometry.js'

// The vector arrows on the map: drawing, and the editing gestures (add on map,
// drag handles). Imperative Leaflet, owned by MapPanel, which stays "dumb": this
// file renders what it is given and reports geometry edits through callbacks --
// it never computes a model. Bearing/distance/arrow math lives in
// utils/geometry.js.
//
// Contract (see MapPanel):
//   render(vectors, editing)   -- rebuilds the arrows
//   setEditing(editing)        -- swaps in fresh callbacks, no rebuild
//     vectors: [{ id, number, lon, lat, azimuthDeg | null, rangeKm | null, lengthKm, selected, custom }]
//     editing?: { mode: 'none' | 'addVector', onAddVector, onUpdateVector,
//                 onSelectVector, onExitAddMode }
//   destroy()
//
// Commit-on-drag-end: layers are updated imperatively while a handle is dragged
// and the callbacks fire once, on drag end. (An arrow is never re-rendered
// mid-drag, because nothing changes React state until then.)

const COLOR = '#0f766e'
const COLOR_SELECTED = '#f97316'
const ICON_TEXT = 'font:600 11px system-ui,sans-serif;'

const toLatLng = ([lon, lat]) => [lat, lon]
const pointOf = (latlng) => [latlng.lng, latlng.lat]

function baseIcon(number, selected, custom) {
  const fill = custom ? (selected ? COLOR_SELECTED : COLOR) : '#fff'
  const text = custom ? '#fff' : selected ? COLOR_SELECTED : COLOR
  const border = selected ? COLOR_SELECTED : COLOR
  return L.divIcon({
    className: '',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    html:
      `<div style="${ICON_TEXT}width:22px;height:22px;border-radius:50%;box-sizing:border-box;` +
      `display:flex;align-items:center;justify-content:center;background:${fill};color:${text};` +
      `border:2px solid ${border};box-shadow:0 0 0 1px #fff">${number}</div>`
  })
}

function tipIcon(selected) {
  const c = selected ? COLOR_SELECTED : COLOR
  return L.divIcon({
    className: '',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
    html: `<div style="width:14px;height:14px;box-sizing:border-box;background:#fff;border:2px solid ${c};border-radius:3px;transform:rotate(45deg);box-shadow:0 0 0 1px #fff"></div>`
  })
}

export function createVectorLayer(map, { pane, container }) {
  const group = L.layerGroup().addTo(map)
  // Latest callbacks, so DOM listeners installed once always call the current ones.
  const editingRef = { current: undefined }
  let addCleanup = null

  function drawArrow(vector) {
    const color = vector.selected ? COLOR_SELECTED : COLOR
    const weight = vector.selected ? 4 : 2
    const geom = arrowGeometry([vector.lon, vector.lat], vector.azimuthDeg, vector.lengthKm)
    const shaft = L.polyline(geom.shaft.map(toLatLng), { pane, color, weight })
    // Custom-tilt vectors get a filled head, global ones a hollow one.
    const head = L.polygon(geom.head.map(toLatLng), {
      pane,
      color,
      weight: vector.selected ? 3 : 1.5,
      fill: vector.custom,
      fillColor: color,
      fillOpacity: vector.custom ? 1 : 0
    })
    return { shaft, head }
  }

  function addVector(vector, editable) {
    const select = () => editingRef.current?.onSelectVector?.(vector.id)
    const base = L.marker([vector.lat, vector.lon], {
      icon: baseIcon(vector.number, vector.selected, vector.custom),
      draggable: editable,
      keyboard: false, // the table is the keyboard path
      interactive: editable,
      pane: 'markerPane',
      zIndexOffset: vector.selected ? 1000 : 0
    })

    let arrow = null
    let tip = null
    if (vector.azimuthDeg !== null) {
      arrow = drawArrow(vector)
      for (const layer of [arrow.shaft, arrow.head]) {
        if (editable) layer.on('click', select)
        group.addLayer(layer)
      }
      if (editable) {
        const tipLatLng = arrow.shaft.getLatLngs()[1]
        tip = L.marker(tipLatLng, {
          icon: tipIcon(vector.selected),
          draggable: true,
          keyboard: false,
          pane: 'markerPane',
          zIndexOffset: vector.selected ? 1000 : 0
        })
      }
    }

    if (editable) {
      base.on('click', select)
      // Moving the base moves the whole arrow (same azimuth and length).
      base.on('drag', () => {
        if (!arrow) return
        const b = pointOf(base.getLatLng())
        const geom = arrowGeometry(b, vector.azimuthDeg, vector.lengthKm)
        arrow.shaft.setLatLngs(geom.shaft.map(toLatLng))
        arrow.head.setLatLngs(geom.head.map(toLatLng))
        tip.setLatLng(toLatLng(geom.shaft[1]))
      })
      base.on('dragend', () => {
        const { lat, lng } = base.getLatLng()
        editingRef.current?.onUpdateVector?.(vector.id, { lon: lng, lat })
        select()
      })
    }
    if (tip) {
      tip.bindTooltip('', { direction: 'top', offset: [0, -8] })
      tip.on('click', select)
      // The tip rotates and resizes: it sets the azimuth and the range.
      tip.on('drag', () => {
        const b = [vector.lon, vector.lat]
        const t = pointOf(tip.getLatLng())
        const az = bearingDeg(b, t)
        const len = distanceKm(b, t)
        if (len > 0) {
          const geom = arrowGeometry(b, az, len)
          arrow.shaft.setLatLngs([toLatLng(b), tip.getLatLng()])
          arrow.head.setLatLngs(geom.head.map(toLatLng))
        }
        tip.setTooltipContent(`${az.toFixed(0)}° · ${len.toFixed(1)} km`)
        tip.openTooltip()
      })
      tip.on('dragend', () => {
        const b = [vector.lon, vector.lat]
        const t = pointOf(tip.getLatLng())
        const rangeKm = distanceKm(b, t)
        if (rangeKm > 0) {
          editingRef.current?.onUpdateVector?.(vector.id, { azimuthDeg: bearingDeg(b, t), rangeKm })
        }
        select()
      })
      group.addLayer(tip)
    }
    group.addLayer(base)
  }

  // --- Add on map: press to set the base point, drag to set direction and
  // range, release to add. Pointer events (so touch works), on the map's own
  // container, with Escape scoped to it too (not window). ---
  function enableAdd() {
    if (addCleanup) return
    map.dragging.disable()
    const previousCursor = container.style.cursor
    const previousTouch = container.style.touchAction
    container.style.cursor = 'crosshair'
    container.style.touchAction = 'none'
    container.tabIndex = -1
    container.focus({ preventScroll: true })

    let start = null // { ll, px }
    let preview = null
    let tooltip = null

    const clearPreview = () => {
      if (preview) map.removeLayer(preview)
      if (tooltip) map.removeLayer(tooltip)
      preview = tooltip = null
    }
    const pxOf = (e) => map.mouseEventToContainerPoint(e)

    const onDown = (e) => {
      if (e.button !== undefined && e.button !== 0) return
      // Existing handles and map controls keep their own behavior.
      if (e.target.closest?.('.leaflet-marker-icon, .leaflet-control')) return
      const px = pxOf(e)
      start = { ll: map.containerPointToLatLng(px), px }
      container.setPointerCapture?.(e.pointerId)
    }
    const onMove = (e) => {
      if (!start) return
      const px = pxOf(e)
      if (isClick(start.px, px)) {
        clearPreview()
        return
      }
      const ll = map.containerPointToLatLng(px)
      const a = pointOf(start.ll)
      const b = pointOf(ll)
      const text = `${bearingDeg(a, b).toFixed(0)}° · ${distanceKm(a, b).toFixed(1)} km`
      if (!preview) {
        preview = L.polyline([start.ll, ll], { pane, color: COLOR_SELECTED, weight: 3, dashArray: '4 4', interactive: false }).addTo(map)
        tooltip = L.tooltip({ permanent: true, direction: 'top', offset: [0, -6] }).setLatLng(ll).setContent(text).addTo(map)
      } else {
        preview.setLatLngs([start.ll, ll])
        tooltip.setLatLng(ll).setContent(text)
      }
    }
    const onUp = (e) => {
      if (!start) return
      const began = start
      start = null
      container.releasePointerCapture?.(e.pointerId)
      clearPreview()
      const px = pxOf(e)
      const base = pointOf(began.ll)
      const add = editingRef.current?.onAddVector
      if (!add) return
      if (isClick(began.px, px)) {
        // A drag under 8 px is a click: place it with no azimuth yet.
        add({ lon: base[0], lat: base[1], azimuthDeg: null, rangeKm: null })
      } else {
        const end = pointOf(map.containerPointToLatLng(px))
        add({ lon: base[0], lat: base[1], azimuthDeg: bearingDeg(base, end), rangeKm: distanceKm(base, end) })
      }
    }
    const onCancel = () => {
      start = null
      clearPreview()
    }
    const onKey = (e) => {
      if (e.key === 'Escape') editingRef.current?.onExitAddMode?.()
    }

    container.addEventListener('pointerdown', onDown)
    container.addEventListener('pointermove', onMove)
    container.addEventListener('pointerup', onUp)
    container.addEventListener('pointercancel', onCancel)
    container.addEventListener('keydown', onKey)

    addCleanup = () => {
      container.removeEventListener('pointerdown', onDown)
      container.removeEventListener('pointermove', onMove)
      container.removeEventListener('pointerup', onUp)
      container.removeEventListener('pointercancel', onCancel)
      container.removeEventListener('keydown', onKey)
      clearPreview()
      container.style.cursor = previousCursor
      container.style.touchAction = previousTouch
      map.dragging.enable()
      addCleanup = null
    }
  }

  function disableAdd() {
    addCleanup?.()
  }

  return {
    // Refreshes the callbacks without rebuilding anything.
    setEditing(editing) {
      editingRef.current = editing
    },
    render(vectors, editing) {
      editingRef.current = editing
      group.clearLayers()
      const editable = !!editing
      for (const v of vectors ?? []) addVector(v, editable)
      if (editing?.mode === 'addVector') enableAdd()
      else disableAdd()
    },
    destroy() {
      disableAdd()
      group.remove()
    }
  }
}
