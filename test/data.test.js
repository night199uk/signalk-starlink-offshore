'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const { TerritoryStore } = require('../lib/data')

test('bundled world dataset loads and answers real positions', () => {
  const bundled = path.join(__dirname, '..', 'lib', 'geodata', 'territorial-seas-world.json.gz')
  if (!fs.existsSync(bundled)) {
    return // dataset not built; nothing to assert
  }
  const store = new TerritoryStore({
    bundledFile: bundled,
    logger: { debug() {}, info() {}, warn() {}, error() {} }
  })
  const n = store.loadBundled()
  assert.ok(n > 100, `bundled dataset should have hundreds of features, got ${n}`)
  assert.ok(store.bundledLoaded)
  const b = store.toBoundaries()
  assert.deepStrictEqual(b.countriesAt(43.1, 5.1), ['France'])
  assert.deepStrictEqual(b.countriesAt(-16, 179), ['Fiji'])
  assert.deepStrictEqual(b.countriesAt(52, -30), [])
})

test('loadBundled returns 0 for a missing file without throwing', () => {
  const store = new TerritoryStore({
    bundledFile: path.join(__dirname, '..', 'does-not-exist.json.gz'),
    logger: { debug() {}, info() {}, warn() {}, error() {} }
  })
  assert.strictEqual(store.loadBundled(), 0)
  assert.strictEqual(store.features.length, 0)
})