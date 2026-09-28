'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { normalizeCountryName } = require('../lib/names')
const { convertFeatureCollection, splitAntimeridian } = require('../lib/features')

test('country name normalisation', () => {
  assert.strictEqual(normalizeCountryName('United Kingdom 12 NM'), 'United Kingdom')
  assert.strictEqual(normalizeCountryName('French 12 NM'), 'French')
  assert.strictEqual(normalizeCountryName('Belgian 12Nm'), 'Belgian')
  assert.strictEqual(normalizeCountryName('Territorial Sea of X'), 'Territorial Sea of X')
  assert.strictEqual(normalizeCountryName(''), '')
  assert.strictEqual(normalizeCountryName('Italy (12 nm)'), 'Italy')
})

test('converts a Polygon feature', () => {
  const geojson = {
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
  const feats = convertFeatureCollection(geojson, ['GEONAME'])
  assert.strictEqual(feats.length, 1)
  assert.strictEqual(feats[0].country, 'Testland')
  assert.strictEqual(feats[0].rings.length, 1)
  assert.strictEqual(feats[0].rings[0].lons.length, 4)
})

test('splits rings that cross the antimeridian', () => {
  const ring = [
    [-1, 178],
    [-1, -178],
    [1, -178],
    [1, 178],
    [-1, 178]
  ]
  const rings = splitAntimeridian(ring)
  assert.ok(rings.length >= 2, `expected >= 2 subrings, got ${rings.length}`)
})

test('defensive conversion of bad input', () => {
  assert.deepStrictEqual(convertFeatureCollection(null, ['GEONAME']), [])
  assert.deepStrictEqual(convertFeatureCollection({ features: [] }, ['GEONAME']), [])
})