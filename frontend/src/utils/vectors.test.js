import { describe, it, expect } from 'vitest'
import {
  MAX_VECTORS,
  UNDO_LIMIT,
  applyImport,
  buildVectorsDirection,
  describeImport,
  fieldsFromGeometry,
  isobaseLabel,
  newVector,
  normalizeVectors,
  parseVectorsCsv,
  popUndo,
  pushUndo,
  vectorIssues,
  vectorsToMapData
} from './vectors.js'

const vec = (patch = {}) => newVector({ lat: '45', lon: '-105', azimuthDeg: '30', ...patch })

describe('newVector / normalizeVectors', () => {
  it('gives every row a distinct stable id and full defaults', () => {
    const a = newVector()
    const b = newVector()
    expect(a.id).toMatch(/^v_/)
    expect(a.id).not.toBe(b.id)
    expect(a).toMatchObject({ lat: '', lon: '', azimuthDeg: '', rangeKm: '', tilt: 'global' })
    expect(a.custom).toEqual({
      family: 'linear',
      localGradient: '',
      curvatureInput: 'secondGradient',
      rateOfIncrease: '',
      secondGradient: '',
      secondGradientDistanceKm: ''
    })
  })

  it('repairs a saved list: missing ids/keys get defaults, junk is dropped', () => {
    const [v] = normalizeVectors([{ lat: '1', custom: { localGradient: '0.4' } }, null, 5])
    expect(normalizeVectors([{}, null, 5])).toHaveLength(1)
    expect(v.id).toMatch(/^v_/)
    expect(v.custom).toMatchObject({ family: 'linear', localGradient: '0.4', curvatureInput: 'secondGradient' })
    expect(normalizeVectors(undefined)).toEqual([])
  })
})

describe('vectorIssues (readiness)', () => {
  it('needs at least one vector', () => {
    expect(vectorIssues([])).toEqual(['at least one vector'])
  })

  it('accepts complete global rows', () => {
    expect(vectorIssues([vec(), vec({ lat: '46', rangeKm: '150' })])).toEqual([])
  })

  it('lists the rows with an invalid latitude, longitude or azimuth', () => {
    const issues = vectorIssues([vec(), vec({ lat: '91' }), vec({ azimuthDeg: '' }), vec({ lon: 'x' }), vec({ lon: '-181' })])
    expect(issues).toEqual(['a valid latitude, longitude and azimuth for vectors 2, 3, 4, 5'])
  })

  it('a range must be greater than 0 when present, and may be empty', () => {
    expect(vectorIssues([vec({ rangeKm: '' })])).toEqual([])
    expect(vectorIssues([vec(), vec({ rangeKm: '0' }), vec({ rangeKm: '-5' })])).toEqual([
      'a range greater than 0 (or empty) for vectors 2, 3'
    ])
  })

  it('any azimuth number is fine (it is normalized)', () => {
    expect(vectorIssues([vec({ azimuthDeg: '-10' }), vec({ azimuthDeg: '370' })])).toEqual([])
  })

  it('custom rows need a local gradient, and only the active curvature form', () => {
    const custom = (c) => vec({ tilt: 'custom', custom: c })
    expect(vectorIssues([custom({ family: 'linear', localGradient: '0.4' })])).toEqual([])
    expect(vectorIssues([custom({ family: 'linear', localGradient: '' })])).toEqual([
      'a complete custom tilt for vector 1'
    ])
    // A quadratic on the second-gradient form: the rate is not required...
    expect(
      vectorIssues([
        custom({
          family: 'quadratic', localGradient: '0.4', curvatureInput: 'secondGradient',
          secondGradient: '1', secondGradientDistanceKm: '50'
        })
      ])
    ).toEqual([])
    // ...and an incomplete second gradient is.
    expect(
      vectorIssues([
        custom({ family: 'quadratic', localGradient: '0.4', curvatureInput: 'secondGradient', secondGradient: '1' })
      ])
    ).toEqual(['a complete custom tilt for vector 1'])
    // The rate form needs its rate, not the second gradient.
    expect(
      vectorIssues([custom({ family: 'quadratic', localGradient: '0.4', curvatureInput: 'rate', rateOfIncrease: '1e-3' })])
    ).toEqual([])
    expect(
      vectorIssues([custom({ family: 'quadratic', localGradient: '0.4', curvatureInput: 'rate', secondGradient: '1',
        secondGradientDistanceKm: '5' })])
    ).toEqual(['a complete custom tilt for vector 1'])
  })

  it('a global row never needs its (hidden) custom fields', () => {
    expect(vectorIssues([vec({ tilt: 'global', custom: { localGradient: '' } })])).toEqual([])
  })

  it('caps the list at 200', () => {
    const many = Array.from({ length: MAX_VECTORS + 1 }, () => vec())
    expect(vectorIssues(many)).toEqual([`no more than ${MAX_VECTORS} vectors`])
  })
})

describe('buildVectorsDirection (payload)', () => {
  it('serializes numbers, range_km null when empty, azimuths normalized into [0, 360)', () => {
    const direction = buildVectorsDirection([
      vec({ lat: '49.9', lon: '-97.2', azimuthDeg: '28', rangeKm: '150' }),
      vec({ azimuthDeg: '-10' }),
      vec({ azimuthDeg: '370' })
    ])
    expect(direction.type).toBe('vectors')
    expect(direction.vectors[0]).toEqual({ lat: 49.9, lon: -97.2, azimuth_deg: 28, range_km: 150, custom: null })
    expect(direction.vectors[1].azimuth_deg).toBe(350)
    expect(direction.vectors[1].range_km).toBeNull()
    expect(direction.vectors[2].azimuth_deg).toBe(10)
  })

  it('a custom linear sends only family and local_gradient', () => {
    const [v] = buildVectorsDirection([vec({ tilt: 'custom', custom: { family: 'linear', localGradient: '0.6' } })]).vectors
    expect(v.custom).toEqual({ family: 'linear', local_gradient: 0.6 })
  })

  it('a custom quadratic sends only its active curvature form (hidden values kept in state, not sent)', () => {
    const base = {
      family: 'quadratic', localGradient: '0.6', rateOfIncrease: '0.004',
      secondGradient: '1.0', secondGradientDistanceKm: '120'
    }
    const second = buildVectorsDirection([vec({ tilt: 'custom', custom: { ...base, curvatureInput: 'secondGradient' } })])
    expect(second.vectors[0].custom).toEqual({
      family: 'quadratic', local_gradient: 0.6,
      second_gradient: { gradient_m_per_km: 1, distance_km: 120 }
    })
    const rate = buildVectorsDirection([vec({ tilt: 'custom', custom: { ...base, curvatureInput: 'rate' } })])
    expect(rate.vectors[0].custom).toEqual({ family: 'quadratic', local_gradient: 0.6, rate_of_increase: 0.004 })
  })

  it('accepts e-notation in gradients', () => {
    const [v] = buildVectorsDirection([
      vec({ tilt: 'custom', custom: { family: 'quadratic', localGradient: '3.5e-1', curvatureInput: 'rate', rateOfIncrease: '6e-3' } })
    ]).vectors
    expect(v.custom.local_gradient).toBeCloseTo(0.35)
    expect(v.custom.rate_of_increase).toBeCloseTo(0.006)
  })
})

describe('vectorsToMapData', () => {
  const extent = [-106, 44, -105, 45]

  it('carries location, direction, length, selection, custom flag and the 1-based row number', () => {
    const a = vec({ rangeKm: '40' })
    const b = vec({ azimuthDeg: '', tilt: 'custom' })
    const out = vectorsToMapData([a, b], b.id, extent)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ id: a.id, number: 1, lon: -105, lat: 45, azimuthDeg: 30, rangeKm: 40, lengthKm: 40, selected: false, custom: false })
    // No azimuth yet (a click-added row): the map draws only its base handle.
    expect(out[1]).toMatchObject({ number: 2, azimuthDeg: null, rangeKm: null, selected: true, custom: true })
    expect(out[1].lengthKm).toBeGreaterThan(0) // 10% of the DEM diagonal
  })

  it('skips rows without a valid location but keeps the numbering of the rest', () => {
    const out = vectorsToMapData([vec({ lat: '' }), vec({ lat: '46' })], null, extent)
    expect(out).toHaveLength(1)
    expect(out[0].number).toBe(2)
  })
})

describe('fieldsFromGeometry (map edits -> row fields)', () => {
  it('formats to fixed precision as strings and wraps the azimuth', () => {
    expect(fieldsFromGeometry({ lon: -104.123456789, lat: 45.987654321, azimuthDeg: 28.04, rangeKm: 12.345 })).toEqual({
      lon: '-104.12346', lat: '45.98765', azimuthDeg: '28.0', rangeKm: '12.3'
    })
    expect(fieldsFromGeometry({ azimuthDeg: -10 }).azimuthDeg).toBe('350.0')
    expect(fieldsFromGeometry({ azimuthDeg: 359.97 }).azimuthDeg).toBe('0.0') // rounds up past 360, wraps
  })

  it('a tiny dragged range is at least 0.1 km; absent or null fields are left out', () => {
    expect(fieldsFromGeometry({ rangeKm: 0.001 }).rangeKm).toBe('0.1')
    expect(fieldsFromGeometry({ lon: 1, lat: 2, azimuthDeg: null, rangeKm: null })).toEqual({ lon: '1.00000', lat: '2.00000' })
  })
})

describe('undo stack', () => {
  it('pops back through the pushed states, newest first', () => {
    let stack = []
    stack = pushUndo(stack, ['a'])
    stack = pushUndo(stack, ['a', 'b'])
    let r = popUndo(stack)
    expect(r.snapshot).toEqual(['a', 'b'])
    r = popUndo(r.stack)
    expect(r.snapshot).toEqual(['a'])
    r = popUndo(r.stack)
    expect(r.snapshot).toBeNull()
    expect(r.stack).toEqual([])
  })

  it('keeps only the last 20 states', () => {
    let stack = []
    for (let i = 0; i < UNDO_LIMIT + 5; i++) stack = pushUndo(stack, [i])
    expect(stack).toHaveLength(UNDO_LIMIT)
    expect(stack[0]).toEqual([5]) // the five oldest were dropped
    expect(stack[stack.length - 1]).toEqual([UNDO_LIMIT + 4])
  })

  it('never mutates the stack it is given', () => {
    const stack = [[1]]
    pushUndo(stack, [2])
    popUndo(stack)
    expect(stack).toEqual([[1]])
  })
})

describe('parseVectorsCsv', () => {
  it('matches header aliases without regard to case', () => {
    for (const header of ['lat,lon,azimuth', 'Latitude,Longitude,AZ', 'LAT,LNG,azimuth_deg', 'latitude , long , Azimuth']) {
      const r = parseVectorsCsv(`${header}\n45.5,-105.25,30\n`)
      expect(r.error).toBeNull()
      expect(r.vectors).toHaveLength(1)
      expect(r.vectors[0]).toMatchObject({ lat: '45.5', lon: '-105.25', azimuthDeg: '30', rangeKm: '', tilt: 'global' })
    }
  })

  it('reads the optional range, and a gradient column makes the row a custom linear tilt', () => {
    const r = parseVectorsCsv('lat,lon,azimuth,range_km,gradient\n45,-105,30,120,0.6\n46,-106,40,,\n')
    expect(r.vectors[0]).toMatchObject({ rangeKm: '120', tilt: 'custom' })
    expect(r.vectors[0].custom).toMatchObject({ family: 'linear', localGradient: '0.6' })
    expect(r.vectors[1]).toMatchObject({ rangeKm: '', tilt: 'global' })
  })

  it('a rate alongside a gradient makes it a custom quadratic on the rate form', () => {
    const r = parseVectorsCsv('lat,lon,azimuth,local_gradient,rate_of_increase\n45,-105,30,0.6,0.004\n')
    expect(r.vectors[0].tilt).toBe('custom')
    expect(r.vectors[0].custom).toMatchObject({
      family: 'quadratic', localGradient: '0.6', curvatureInput: 'rate', rateOfIncrease: '0.004'
    })
  })

  it('skips invalid rows whole, reporting the data-row number and reason; good rows still import', () => {
    const csv = [
      'lat,lon,azimuth,range,gradient,rate',
      '45,-105,30,,,', //            row 1 ok
      '45,-105,,,,', //              row 2 azimuth missing
      '95,-105,30,,,', //            row 3 latitude out of range
      '45,-200,30,,,', //            row 4 longitude out of range
      'abc,-105,30,,,', //           row 5 latitude not a number
      '45,-105,30,0,,', //           row 6 range must be > 0
      '45,-105,30,,x,', //           row 7 gradient not a number
      '45,-105,30,,,0.1', //         row 8 rate without gradient
      '46,-106,40,10,,' //           row 9 ok
    ].join('\n')
    const r = parseVectorsCsv(csv)
    expect(r.vectors.map((v) => v.lat)).toEqual(['45', '46'])
    expect(r.skipped).toEqual([
      { row: 2, reason: 'azimuth missing' },
      { row: 3, reason: 'latitude out of range' },
      { row: 4, reason: 'longitude out of range' },
      { row: 5, reason: 'latitude is not a number' },
      { row: 6, reason: 'range must be greater than 0' },
      { row: 7, reason: 'gradient is not a number' },
      { row: 8, reason: 'rate given without a gradient' }
    ])
    expect(describeImport(r)).toBe(
      '2 imported, 7 skipped: row 2 azimuth missing, row 3 latitude out of range, row 4 longitude out of range, ' +
        'row 5 latitude is not a number, row 6 range must be greater than 0, and 2 more'
    )
  })

  it('reports the spec example shape: "12 imported, 2 skipped: row 5 azimuth missing, row 9 latitude out of range"', () => {
    const rows = Array.from({ length: 14 }, (_, i) => `45,-105,${i}`)
    rows[4] = '45,-105,'
    rows[8] = '95,-105,10'
    const r = parseVectorsCsv(`lat,lon,azimuth\n${rows.join('\n')}`)
    expect(describeImport(r)).toBe('12 imported, 2 skipped: row 5 azimuth missing, row 9 latitude out of range')
  })

  it('handles quoted fields, blank lines and surrounding whitespace', () => {
    const r = parseVectorsCsv('lat,lon,azimuth,note\n" 45.5 ",-105,30,"a, quoted, note"\n\n')
    expect(r.error).toBeNull()
    expect(r.vectors).toHaveLength(1)
    expect(r.vectors[0].lat).toBe('45.5')
  })

  it('normalizes the azimuth into [0, 360)', () => {
    const r = parseVectorsCsv('lat,lon,azimuth\n45,-105,-10\n45,-105,370\n')
    expect(r.vectors.map((v) => v.azimuthDeg)).toEqual(['350', '10'])
  })

  it('errors, importing nothing, when a required column is missing or there are no rows', () => {
    const noAzimuth = parseVectorsCsv('lat,lon\n45,-105\n')
    expect(noAzimuth.error).toMatch(/needs an azimuth column/)
    expect(noAzimuth.vectors).toEqual([])
    expect(parseVectorsCsv('x,y,z\n1,2,3').error).toMatch(/needs a lat, a lon, an azimuth columns/)
    expect(parseVectorsCsv('lat,lon,azimuth\n').error).toBe('The CSV has no data rows.')
    expect(parseVectorsCsv('').error).toMatch(/needs/)
  })

  it('imported rows get distinct ids', () => {
    const r = parseVectorsCsv('lat,lon,azimuth\n45,-105,30\n46,-105,30\n')
    expect(new Set(r.vectors.map((v) => v.id)).size).toBe(2)
  })
})

describe('applyImport', () => {
  const existing = [vec({ lat: '1' }), vec({ lat: '2' })]
  const imported = [vec({ lat: '3' })]

  it('replace discards the existing vectors', () => {
    expect(applyImport(existing, imported, 'replace')).toEqual(imported)
  })

  it('append keeps them, then adds the imported rows', () => {
    expect(applyImport(existing, imported, 'append').map((v) => v.lat)).toEqual(['1', '2', '3'])
  })

  it('never exceeds the 200-vector cap', () => {
    const many = Array.from({ length: 150 }, () => vec())
    expect(applyImport(many, many, 'append')).toHaveLength(MAX_VECTORS)
  })
})

describe('isobaseLabel', () => {
  it('signs the relative uplift', () => {
    expect(isobaseLabel(40)).toBe('+40 m')
    expect(isobaseLabel(-20)).toBe('−20 m')
    expect(isobaseLabel(0)).toBe('0 m')
    expect(isobaseLabel(2.5)).toBe('+2.5 m')
    expect(isobaseLabel(0.30000000000000004)).toBe('+0.3 m')
    expect(isobaseLabel(NaN)).toBe('')
  })
})
