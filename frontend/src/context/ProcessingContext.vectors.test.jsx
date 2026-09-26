// Vector state in the processing context (spec 5): persistence, the transient
// keys, and the undo stack.
import { describe, it, expect, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'

import { ProcessingProvider, useProcessing } from './ProcessingContext.jsx'
import { UNDO_LIMIT, newVector } from '../utils/vectors.js'

const STORAGE_KEY = 'gia-tool:last-run'

let ctx
function Probe() {
  ctx = useProcessing()
  return null
}
const mount = () =>
  render(
    <ProcessingProvider>
      <Probe />
    </ProcessingProvider>
  )
const saved = () => JSON.parse(window.localStorage.getItem(STORAGE_KEY))
const ids = () => ctx.formState.advanced.vectors.map((v) => v.id)

beforeEach(() => {
  window.localStorage.clear()
  ctx = null
})

describe('defaults', () => {
  it('start on the azimuth source with no vectors and nothing selected', () => {
    mount()
    expect(ctx.formState.advanced.directionSource).toBe('azimuth')
    expect(ctx.formState.advanced.vectors).toEqual([])
    expect(ctx.formState.selectedVectorId).toBeNull()
    expect(ctx.formState.mapEditMode).toBe('none')
    expect(ctx.formState.upliftPreview).toBeNull()
    expect(ctx.undoDepth).toBe(0)
  })
})

describe('persistence', () => {
  it('vectors and the direction source persist across a reload; the selection does not', () => {
    const first = mount()
    const a = newVector({ lat: '45', lon: '-105', azimuthDeg: '30' })
    const b = newVector({ lat: '46', lon: '-104', azimuthDeg: '40', tilt: 'custom', custom: { localGradient: '0.6' } })
    act(() => {
      ctx.updateAdvanced({ directionSource: 'vectors' })
      ctx.setVectors([a, b])
      ctx.selectVector(b.id)
      ctx.setMapEditMode('addVector')
      ctx.updateForm({ upliftPreview: { status: 'ready', data: { x: 1 }, error: null }, vectorFocusRequest: { id: a.id, n: 1 } })
    })
    expect(ctx.formState.selectedVectorId).toBe(b.id)

    // Nothing transient reaches localStorage.
    const stored = saved()
    for (const key of ['selectedVectorId', 'mapEditMode', 'upliftPreview', 'vectorFocusRequest']) {
      expect(stored).not.toHaveProperty(key)
    }
    expect(stored.advanced.vectors).toHaveLength(2)

    first.unmount()
    mount()
    expect(ctx.formState.advanced.directionSource).toBe('vectors')
    expect(ids()).toEqual([a.id, b.id]) // stable ids survive
    expect(ctx.formState.advanced.vectors[1]).toMatchObject({ tilt: 'custom', custom: { localGradient: '0.6' } })
    expect(ctx.formState.selectedVectorId).toBeNull()
    expect(ctx.formState.mapEditMode).toBe('none')
    expect(ctx.formState.upliftPreview).toBeNull()
  })

  it('an older save without vectors loads with the defaults', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ mode: 'advanced', tiltAzimuth: '30', advanced: { sectionsOpen: { dem: true, origin: true, tilt: true, output: false } } })
    )
    mount()
    expect(ctx.formState.mode).toBe('advanced')
    expect(ctx.formState.advanced.directionSource).toBe('azimuth')
    expect(ctx.formState.advanced.vectors).toEqual([])
  })

  it('repairs a saved vector list (missing ids and keys) and ignores an unknown direction source', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ advanced: { directionSource: 'shore', vectors: [{ lat: '45' }, null] } })
    )
    mount()
    expect(ctx.formState.advanced.directionSource).toBe('azimuth')
    expect(ctx.formState.advanced.vectors).toHaveLength(1)
    expect(ctx.formState.advanced.vectors[0]).toMatchObject({ lat: '45', lon: '', tilt: 'global' })
    expect(ctx.formState.advanced.vectors[0].id).toMatch(/^v_/)
  })

  it('switching modes never touches the vectors', () => {
    mount()
    const v = newVector({ lat: '45' })
    act(() => {
      ctx.updateAdvanced({ directionSource: 'vectors' })
      ctx.setVectors([v])
    })
    const before = structuredClone(ctx.formState.advanced)
    act(() => ctx.updateForm({ mode: 'advanced' }))
    act(() => ctx.updateForm({ mode: 'basic' }))
    expect(ctx.formState.advanced).toEqual(before)
  })
})

describe('undo', () => {
  it('undoes structural edits one at a time, back to the start', () => {
    mount()
    const a = newVector({ lat: '1' })
    const b = newVector({ lat: '2' })
    act(() => ctx.setVectors((l) => [...l, a], { undoable: true }))
    act(() => ctx.setVectors((l) => [...l, b], { undoable: true }))
    expect(ids()).toEqual([a.id, b.id])
    expect(ctx.undoDepth).toBe(2)

    act(() => ctx.undoVectors())
    expect(ids()).toEqual([a.id])
    act(() => ctx.undoVectors())
    expect(ids()).toEqual([])
    expect(ctx.undoDepth).toBe(0)
    act(() => ctx.undoVectors()) // nothing left: a no-op
    expect(ids()).toEqual([])
  })

  it('typing in a cell is not an undo step', () => {
    mount()
    const a = newVector({ lat: '1' })
    act(() => ctx.setVectors([a], { undoable: true }))
    act(() => ctx.setVectors((l) => l.map((v) => ({ ...v, lat: '12' }))))
    act(() => ctx.setVectors((l) => l.map((v) => ({ ...v, lat: '123' }))))
    expect(ctx.undoDepth).toBe(1)
  })

  it('a removal can be undone, and undo restores the removed vector with its id', () => {
    mount()
    const a = newVector({ lat: '1' })
    const b = newVector({ lat: '2' })
    act(() => ctx.setVectors([a, b], { undoable: true }))
    act(() => ctx.setVectors((l) => l.filter((v) => v.id !== a.id), { undoable: true }))
    expect(ids()).toEqual([b.id])
    act(() => ctx.undoVectors())
    expect(ids()).toEqual([a.id, b.id])
  })

  it('keeps only the last 20 states', () => {
    mount()
    for (let i = 0; i < UNDO_LIMIT + 6; i++) {
      act(() => ctx.setVectors((l) => [...l, newVector({ lat: String(i) })], { undoable: true }))
    }
    expect(ctx.undoDepth).toBe(UNDO_LIMIT)
    for (let i = 0; i < UNDO_LIMIT + 3; i++) act(() => ctx.undoVectors())
    // 26 vectors were added; 20 undos leave the first 6.
    expect(ctx.formState.advanced.vectors).toHaveLength(6)
    expect(ctx.undoDepth).toBe(0)
  })

  it('two edits in one tick each start from the previous result', () => {
    mount()
    const a = newVector({ lat: '1' })
    const b = newVector({ lat: '2' })
    act(() => {
      ctx.setVectors((l) => [...l, a], { undoable: true })
      ctx.setVectors((l) => [...l, b], { undoable: true })
    })
    expect(ids()).toEqual([a.id, b.id])
    act(() => ctx.undoVectors())
    expect(ids()).toEqual([a.id])
  })

  it('an unchanged list is not recorded', () => {
    mount()
    act(() => ctx.setVectors((l) => l, { undoable: true }))
    expect(ctx.undoDepth).toBe(0)
  })
})

describe('selection', () => {
  it('is cleared when the selected vector is removed, kept when another is', () => {
    mount()
    const a = newVector()
    const b = newVector()
    act(() => {
      ctx.setVectors([a, b])
      ctx.selectVector(a.id)
    })
    act(() => ctx.setVectors((l) => l.filter((v) => v.id !== b.id)))
    expect(ctx.formState.selectedVectorId).toBe(a.id)
    act(() => ctx.setVectors([]))
    expect(ctx.formState.selectedVectorId).toBeNull()
  })

  it('requestVectorFocus bumps a counter so the same vector can be focused again', () => {
    mount()
    const a = newVector()
    act(() => ctx.requestVectorFocus(a.id))
    expect(ctx.formState.vectorFocusRequest).toEqual({ id: a.id, n: 1 })
    act(() => ctx.requestVectorFocus(a.id))
    expect(ctx.formState.vectorFocusRequest).toEqual({ id: a.id, n: 2 })
  })
})
