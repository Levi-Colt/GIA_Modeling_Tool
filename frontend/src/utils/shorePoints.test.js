// Shore-point helpers (spec 6): the row model, order feasibility, readiness
// reasons, payload, map adapter and CSV parsing with a column mapping.
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SURFACE,
  autoMapColumns,
  buildFitBody,
  buildPointsDirection,
  elevationLabel,
  feasibleOrders,
  minPointsForOrder,
  newShorePoint,
  normalizeShorePoints,
  parseShorePointsCsv,
  pointIssues,
  shorePointsToMapData,
  surfaceOf
} from './shorePoints.js'

const point = (patch = {}) => newShorePoint({ lat: '45.1', lon: '-104.9', elevationM: '331.4', ...patch })
const points = (n, patch = () => ({})) => Array.from({ length: n }, (_, i) => point({ lat: String(45 + i / 100), ...patch(i) }))

describe('order feasibility', () => {
  it('needs terms + 3 points: 6, 9 and 13', () => {
    expect([1, 2, 3].map(minPointsForOrder)).toEqual([6, 9, 13])
  })

  it('lists the orders a point count supports', () => {
    expect(feasibleOrders(5)).toEqual([])
    expect(feasibleOrders(6)).toEqual([1])
    expect(feasibleOrders(9)).toEqual([1, 2])
    expect(feasibleOrders(13)).toEqual([1, 2, 3])
  })
})

describe('surfaceOf', () => {
  it('defaults: order 2, apply as fitted, warn outside the data', () => {
    expect(DEFAULT_SURFACE).toEqual({ order: 2, hinge: 'none', extrapolation: 'warn' })
    expect(surfaceOf({})).toEqual(DEFAULT_SURFACE)
    expect(surfaceOf(undefined)).toEqual(DEFAULT_SURFACE)
  })

  it('repairs unknown saved values', () => {
    expect(surfaceOf({ surface: { order: 7, hinge: 'natural', extrapolation: 'clip' } })).toEqual(DEFAULT_SURFACE)
    expect(surfaceOf({ surface: { order: 3, hinge: 'origin', extrapolation: 'mask' } })).toEqual({
      order: 3,
      hinge: 'origin',
      extrapolation: 'mask'
    })
  })
})

describe('pointIssues', () => {
  const surface = (order) => ({ ...DEFAULT_SURFACE, order })

  it('needs the minimum count for the chosen order, with a hint to lower it', () => {
    expect(pointIssues(points(8), surface(2))).toEqual([
      'at least 9 shore points for an order-2 surface (or choose a lower order)'
    ])
    expect(pointIssues(points(9), surface(2))).toEqual([])
    expect(pointIssues(points(12), surface(3))).toHaveLength(1)
    expect(pointIssues(points(13), surface(3))).toEqual([])
    expect(pointIssues(points(6), surface(1))).toEqual([])
    expect(pointIssues([], surface(1))).toHaveLength(1)
  })

  it('reports invalid rows by their 1-based number', () => {
    const list = points(9, (i) => (i === 2 ? { lat: '95' } : i === 4 ? { elevationM: '' } : {}))
    expect(pointIssues(list, surface(2))).toEqual(['a valid latitude, longitude and elevation for points 3, 5'])
  })

  it('caps the list', () => {
    expect(pointIssues(points(5001), surface(1))[0]).toBe('no more than 5000 shore points')
  })
})

describe('buildPointsDirection', () => {
  it('sends numbers, the options, and a label only when present', () => {
    const list = [point({ label: ' Site A ' }), point({ lat: '45.2', elevationM: '1e2', label: '  ' })]
    const d = buildPointsDirection(list, { order: 1, hinge: 'origin', extrapolation: 'mask' })
    expect(d).toEqual({
      type: 'points',
      points: [
        { lat: 45.1, lon: -104.9, elevation_m: 331.4, label: 'Site A' },
        { lat: 45.2, lon: -104.9, elevation_m: 100 }
      ],
      order: 1,
      hinge: 'origin',
      extrapolation: 'mask'
    })
    expect('label' in d.points[1]).toBe(false)
  })

  it('never sends a label past 100 characters', () => {
    const d = buildPointsDirection([point({ label: 'x'.repeat(150) })], DEFAULT_SURFACE)
    expect(d.points[0].label).toHaveLength(100)
  })
})

describe('buildFitBody', () => {
  const advanced = (n) => ({ shorePoints: points(n), surface: DEFAULT_SURFACE })

  it('is the /api/fit-uplift-surface body once runnable, origin and bounds known', () => {
    const body = buildFitBody(advanced(9), [-105, 45], [-106, 44, -104, 46])
    expect(Object.keys(body).sort()).toEqual(['bounds_wgs84', 'extrapolation', 'hinge', 'order', 'origin', 'points'])
    expect(body.points).toHaveLength(9)
    expect(body).toMatchObject({ order: 2, hinge: 'none', extrapolation: 'warn', origin: [-105, 45] })
  })

  it('is null while something is missing', () => {
    expect(buildFitBody(advanced(8), [-105, 45], [-106, 44, -104, 46])).toBeNull()
    expect(buildFitBody(advanced(9), null, [-106, 44, -104, 46])).toBeNull()
    expect(buildFitBody(advanced(9), [-105, 45], null)).toBeNull()
  })
})

describe('shorePointsToMapData', () => {
  it('aligns residuals and outliers by row index and skips rows without a location', () => {
    const list = [point({ label: 'A' }), point({ lat: '' }), point({ label: 'C' })]
    const fit = { residuals_m: [1.5, -9, -2.5], outlier_indices: [2] }
    const out = shorePointsToMapData(list, fit)
    expect(out.map((p) => p.id)).toEqual([list[0].id, list[2].id])
    expect(out[0]).toMatchObject({ lon: -104.9, lat: 45.1, elevationM: 331.4, residualM: 1.5, outlier: false, label: 'A' })
    expect(out[1]).toMatchObject({ residualM: -2.5, outlier: true })
  })

  it('draws neutral (null residual) without a fit', () => {
    expect(shorePointsToMapData([point()], null)[0]).toMatchObject({ residualM: null, outlier: false })
  })
})

describe('normalizeShorePoints / elevationLabel', () => {
  it('gives every saved row an id and all its keys', () => {
    const [p] = normalizeShorePoints([{ lat: '1' }, null, 'x'])
    expect(p).toMatchObject({ lat: '1', lon: '', elevationM: '', label: '' })
    expect(p.id).toMatch(/^p_/)
    expect(normalizeShorePoints('nope')).toEqual([])
  })

  it('labels an isobase in absolute meters', () => {
    expect(elevationLabel(331)).toBe('331 m')
    expect(elevationLabel(-12.5)).toBe('−12.5 m')
    expect(elevationLabel(NaN)).toBe('')
  })
})

describe('CSV import', () => {
  const csv = (...lines) => lines.join('\n')

  it('matches headers case-insensitively, by alias', () => {
    const r = parseShorePointsCsv(csv('Latitude,LNG,Elev,Site Name', '45.1,-104.9,331.4,A', '45.2,-104.8,340,B'))
    expect(r.needsMapping).toBe(false)
    expect(r.items).toHaveLength(2)
    expect(r.items[0]).toMatchObject({ lat: '45.1', lon: '-104.9', elevationM: '331.4' })
    expect(r.skipped).toEqual([])
  })

  it('uses the optional label column under any of its aliases', () => {
    for (const header of ['site', 'name', 'site_name', 'label']) {
      const r = parseShorePointsCsv(csv(`lat,lon,z,${header}`, '45,-105,300,Pit 7'))
      expect(r.items[0].label).toBe('Pit 7')
    }
    const none = parseShorePointsCsv(csv('lat,lon,height', '45,-105,300'))
    expect(none.items[0].label).toBe('')
  })

  it('skips invalid rows whole and reports them by data-row number', () => {
    const r = parseShorePointsCsv(
      csv('lat,lon,elevation', '45,-105,300', '95,-105,300', '45,-105,', '45,abc,300', '45,-105,331 m', '46,-104,310')
    )
    expect(r.items.map((p) => p.elevationM)).toEqual(['300', '310'])
    expect(r.skipped).toEqual([
      { row: 2, reason: 'latitude out of range' },
      { row: 3, reason: 'elevation missing' },
      { row: 4, reason: 'longitude is not a number' },
      { row: 5, reason: 'elevation is not a number' }
    ])
  })

  it('asks for a column mapping when a required header cannot be matched', () => {
    const r = parseShorePointsCsv(csv('id,y_deg,x_deg,alt', '1,45.1,-104.9,331.4'))
    expect(r.needsMapping).toBe(true)
    expect(r.items).toEqual([])
    expect(r.columns.headers).toEqual(['id', 'y_deg', 'x_deg', 'alt'])
    expect(r.columns.mapping).toEqual({ lat: null, lon: null, elevation: null, label: null })
    expect(r.columns.preview).toEqual([['1', '45.1', '-104.9', '331.4']])
  })

  it('imports with a chosen mapping, addressing columns by index (so duplicate or blank headers work)', () => {
    // A supplementary-sheet style header: repeated names, a blank column, unrelated columns.
    const text = csv(
      'Site,Notes,Y,X,Elevation Source,Elevation Source,',
      'A,ok,45.1,-104.9,GPS,331.4,',
      'B,,45.2,-104.8,LiDAR,340.2,x',
      'C,bad,46.0,-104.7,GPS,,'
    )
    const first = parseShorePointsCsv(text)
    expect(first.needsMapping).toBe(true)
    expect(first.columns.mapping.label).toBe(0) // 'Site' still matched on its own

    const r = parseShorePointsCsv(text, { lat: 2, lon: 3, elevation: 5, label: 0 })
    expect(r.needsMapping).toBe(false)
    expect(r.items.map((p) => [p.label, p.lat, p.lon, p.elevationM])).toEqual([
      ['A', '45.1', '-104.9', '331.4'],
      ['B', '45.2', '-104.8', '340.2']
    ])
    expect(r.skipped).toEqual([{ row: 3, reason: 'elevation missing' }])
  })

  it('reports an empty file and a header-only file', () => {
    expect(parseShorePointsCsv('').error).toBe('The CSV is empty.')
    expect(parseShorePointsCsv('lat,lon,elevation\n').error).toBe('The CSV has no data rows.')
  })

  it('autoMapColumns returns column indexes (null where nothing matched)', () => {
    expect(autoMapColumns(['Lat', ' Longitude ', 'z', 'x'])).toEqual({ lat: 0, lon: 1, elevation: 2, label: null })
  })
})
