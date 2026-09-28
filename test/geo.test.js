'use strict'

const test = require('node:test')
const assert = require('node:assert')

const {
  haversineM,
  haversineNm,
  initialBearingDeg,
  destination,
  pointToSegmentNm,
  pointInRing,
  normalizeDeg,
  toRadians,
  bisectCrossing,
  sameCountrySet
} = require('../lib/geo')

test('haversine distance London -> Paris ~ 344 km', () => {
  const d = haversineM(51.5074, -0.1278, 48.8566, 2.3522)
  assert.ok(d > 334000 && d < 346000, `got ${d}`)
})

test('destination round trips against haversine', () => {
  const p = destination(50, -4, 120, 100)
  const d = haversineNm(50, -4, p.lat, p.lon)
  assert.ok(Math.abs(d - 100) < 0.2, `got ${d}`)
})

test('initial bearing east is 90', () => {
  const b = initialBearingDeg(0, 0, 0, 10)
  assert.ok(Math.abs(b - 90) < 0.5, `got ${b}`)
})

test('normalizeDeg wraps negative/positive', () => {
  assert.strictEqual(normalizeDeg(370), 10)
  assert.strictEqual(normalizeDeg(-10), 350)
  assert.strictEqual(normalizeDeg(0), 0)
})

test('toRadians accepts degrees or radians', () => {
  assert.ok(Math.abs(toRadians(180) - Math.PI) < 1e-9)
  assert.ok(Math.abs(toRadians(Math.PI) - Math.PI) < 1e-12)
  assert.strictEqual(toRadians(null), null)
  assert.strictEqual(toRadians(NaN), null)
})

test('pointInRing even-odd with a small square', () => {
  const ring = [
    [0, 0],
    [0, 1],
    [1, 1],
    [1, 0],
    [0, 0]
  ]
  assert.ok(pointInRing(0.5, 0.5, ring))
  assert.ok(!pointInRing(1.5, 0.5, ring))
  assert.ok(!pointInRing(0.5, -0.5, ring))
})

test('pointToSegmentNm returns perpendicular distance', () => {
  // segment along latitude 1 from lon -1 to 1
  const d = pointToSegmentNm(1.25, 0, 1, -1, 1, 1)
  assert.ok(Math.abs(d - 15) < 0.3, `got ${d}`)
})

test('bisectCrossing finds a step change', () => {
  const fn = (d) => (d < 10 ? ['A'] : [])
  const r = bisectCrossing(fn, 0, 20, 16)
  assert.ok(r.distanceNm > 9.99 && r.distanceNm < 10.01, `got ${r.distanceNm}`)
})

test('sameCountrySet', () => {
  assert.ok(sameCountrySet(['A', 'B'], ['B', 'A']))
  assert.ok(!sameCountrySet(['A'], ['A', 'B']))
  assert.ok(sameCountrySet([], []))
})