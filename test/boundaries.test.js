'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { Boundaries } = require('../lib/boundaries')
const { convertFeatureCollection } = require('../lib/features')

const SQUARE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { GEONAME: 'Testland 12 NM' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
            [-1, -1]
          ]
        ]
      }
    }
  ]
}

function boundariesFrom(geojson) {
  const b = new Boundaries()
  b.addFeatures(convertFeatureCollection(geojson, ['GEONAME']))
  return b
}

test('countriesAt inside and outside', () => {
  const b = boundariesFrom(SQUARE)
  assert.deepStrictEqual(b.countriesAt(0, 0), ['Testland'])
  assert.deepStrictEqual(b.countriesAt(2, 2), [])
  assert.deepStrictEqual(b.countriesAt(0.5, -0.5), ['Testland'])
})

test('nearestBoundaryNm from outside', () => {
  const b = boundariesFrom(SQUARE)
  const d = b.nearestBoundaryNm(1.5, 0, 120)
  assert.ok(Math.abs(d - 30) < 0.5, `got ${d}`)
})

test('predicts leaving the territorial sea', () => {
  const b = boundariesFrom(SQUARE)
  const speedMps = (10 * 1852) / 3600
  const r = b.analyzeCourse(0, 0, 90, speedMps, {
    stepNm: 0.2,
    horizonNm: 300,
    maxCrossings: 3
  })
  assert.deepStrictEqual(r.startCountries, ['Testland'])
  assert.strictEqual(r.crossings.length, 1, JSON.stringify(r.crossings))
  const c = r.crossings[0]
  assert.strictEqual(c.type, 'leave')
  assert.deepStrictEqual(c.countriesLeaving, ['Testland'])
  assert.ok(Math.abs(c.distanceNm - 60) < 0.5, `got ${c.distanceNm}`)
  // 60 nm at 10 kn is 6 hours = 21600 s
  assert.ok(Math.abs(c.timeSeconds - 21600) < 360, `got ${c.timeSeconds}`)
})

test('predicts entering a territorial sea', () => {
  const b = boundariesFrom(SQUARE)
  const speedMps = (10 * 1852) / 3600
  const r = b.analyzeCourse(0, 1.5, 270, speedMps, {
    stepNm: 0.2,
    horizonNm: 120,
    maxCrossings: 3
  })
  assert.deepStrictEqual(r.startCountries, [])
  assert.strictEqual(r.crossings.length, 1, JSON.stringify(r.crossings))
  const c = r.crossings[0]
  assert.strictEqual(c.type, 'enter')
  assert.deepStrictEqual(c.countriesEntering, ['Testland'])
  assert.ok(Math.abs(c.distanceNm - 30) < 0.5, `got ${c.distanceNm}`)
})

test('predicts a direct transition between countries', () => {
  const two = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { GEONAME: 'Westland 12 NM' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-2, -1],
              [0, -1],
              [0, 1],
              [-2, 1],
              [-2, -1]
            ]
          ]
        }
      },
      {
        type: 'Feature',
        properties: { GEONAME: 'Eastland 12 NM' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [0, -1],
              [2, -1],
              [2, 1],
              [0, 1],
              [0, -1]
            ]
          ]
        }
      }
    ]
  }
  const b = boundariesFrom(two)
  const speedMps = (10 * 1852) / 3600
  const r = b.analyzeCourse(-0.5, -0.5, 90, speedMps, {
    stepNm: 0.2,
    horizonNm: 120,
    maxCrossings: 3
  })
  assert.deepStrictEqual(r.startCountries, ['Westland'])
  assert.strictEqual(r.crossings.length, 1, JSON.stringify(r.crossings))
  const c = r.crossings[0]
  assert.strictEqual(c.type, 'transition')
  assert.deepStrictEqual(c.countriesLeaving, ['Westland'])
  assert.deepStrictEqual(c.countriesEntering, ['Eastland'])
})

test('antimeridian feature is recognized on both sides', () => {
  const dateline = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { GEONAME: 'Dateline 12 NM' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [178, -17],
              [-178, -17],
              [-178, -15],
              [178, -15],
              [178, -17]
            ]
          ]
        }
      }
    ]
  }
  const b = boundariesFrom(dateline)
  assert.deepStrictEqual(b.countriesAt(-16, 179), ['Dateline'])
  assert.deepStrictEqual(b.countriesAt(-16, -179), ['Dateline'])
  assert.deepStrictEqual(b.countriesAt(-40, 170), [])
})

test('forecast requires a course', () => {
  const b = boundariesFrom(SQUARE)
  const r = b.analyzeCourse(0, 0, null, 1, { horizonNm: 100 })
  assert.strictEqual(r.crossings.length, 0)
  assert.deepStrictEqual(r.startCountries, ['Testland'])
})