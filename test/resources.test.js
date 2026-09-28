'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')

const { simplifyRing } = require('../lib/simplify')
const { createRegionsProvider } = require('../lib/resources')

function writeRegionsFile(regions) {
  const file = path.join(
    os.tmpdir(),
    `regions-test-${process.pid}-${Math.random().toString(36).slice(2)}.json.gz`
  )
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify({ format: 1, regions }), 'utf8')))
  return file
}

function region(id, bbox) {
  return {
    id,
    bbox,
    resource: {
      id,
      name: id,
      description: 'test',
      feature: {
        type: 'Feature',
        properties: { country: id },
        geometry: { type: 'MultiPolygon', coordinates: [] }
      }
    }
  }
}

test('simplifyRing drops collinear mid-edge points', () => {
  const lons = [0, 0, 0, 0.5, 1, 1, 1, 0.5]
  const lats = [0, 0.5, 1, 1, 1, 0.5, 0, 0]
  const out = simplifyRing(lons, lats, 1e-3)
  assert.strictEqual(out.lons.length, 4, 'only the four corners survive')
  assert.deepStrictEqual(out.lons, [0, 0, 1, 1])
  assert.deepStrictEqual(out.lats, [0, 1, 1, 0])
})

test('simplifyRing keeps vertices that deviate beyond the tolerance', () => {
  const lons = [0, 0, 0, 0.5, 1, 1, 1, 0.5]
  const lats = [0, 0.5, 1, 1.5, 1, 0.5, 0, 0]
  const out = simplifyRing(lons, lats, 0.05)
  assert.strictEqual(out.lons.length, 5, 'corner plus the bulging top edge vertex')
})

test('simplifyRing preserves the ring endpoints and never grows it', () => {
  const lons = []
  const lats = []
  for (let i = 0; i <= 40; i++) {
    lons.push(i * 0.01)
    lats.push(Math.sin(i) * 0.05)
  }
  const out = simplifyRing(lons, lats, 0.02)
  assert.ok(out.lons.length <= lons.length)
  assert.strictEqual(out.lons[0], lons[0])
  assert.strictEqual(out.lons[out.lons.length - 1], lons[lons.length - 1])
  assert.strictEqual(out.lats[0], lats[0])
  assert.strictEqual(out.lats[out.lats.length - 1], lats[lats.length - 1])
})

test('simplifyRing returns tiny rings unchanged', () => {
  const lons = [1, 1.0001, 1.0002, 1.0001]
  const lats = [1, 1.0001, 1, 0.9999]
  const out = simplifyRing(lons, lats, 0.02)
  assert.deepStrictEqual(out.lons, lons)
  assert.deepStrictEqual(out.lats, lats)
})

test('provider returns an empty list when the file is missing', async () => {
  const provider = createRegionsProvider({
    file: path.join(os.tmpdir(), 'does-not-exist.json.gz'),
    logger: { error() {} }
  })
  assert.strictEqual(provider.type, 'regions')
  assert.strictEqual(provider.count, 0)
  assert.deepStrictEqual(await provider.methods.listResources({}), {})
})

test('provider lists and fetches resources, validates bbox queries', async () => {
  const file = writeRegionsFile([
    region('colombia', [-82.04, -4.23, -66.87, 16.05]),
    region('france', [2, 41, 2.5, 41.5]),
    region('comoros', [42.82, -12.98, 44.97, -11.16])
  ])
  const provider = createRegionsProvider({ file })

  const all = await provider.methods.listResources({})
  assert.deepStrictEqual(Object.keys(all).sort(), ['colombia', 'comoros', 'france'])

  const near = await provider.methods.listResources({ bbox: '42,-13,46,-11' })
  assert.deepStrictEqual(Object.keys(near), ['comoros'])

  const none = await provider.methods.listResources({ bbox: '0,0,1,1' })
  assert.deepStrictEqual(none, {})

  const res = await provider.methods.getResource('colombia')
  assert.strictEqual(res.name, 'colombia')
  assert.strictEqual(res.feature.geometry.type, 'MultiPolygon')

  assert.strictEqual(await provider.methods.getResource('colombia', 'name'), 'colombia')
  await assert.rejects(() => provider.methods.getResource('nope'), /not found/i)
})

test('provider exposes the ResourceProvider shape the registry validates', () => {
  const file = writeRegionsFile([region('france', [0, 40, 2, 44])])
  const provider = createRegionsProvider({ file })
  // signalk-server's ResourceProviderRegistry.isResourceProvider() requires the
  // callable methods to live under a 'methods' property.
  assert.strictEqual(provider.type, 'regions')
  assert.ok(provider.methods, 'provider.methods is required by the registry')
  for (const name of ['listResources', 'getResource', 'setResource', 'deleteResource']) {
    assert.strictEqual(typeof provider.methods[name], 'function', `${name} is callable`)
  }
  assert.strictEqual(provider.count, 1)
})

test('provider rejects writes as a read-only provider', async () => {
  const file = writeRegionsFile([region('france', [0, 40, 2, 44])])
  const provider = createRegionsProvider({ file })
  await assert.rejects(() => provider.methods.setResource('france', {}), /Not implemented/)
  await assert.rejects(() => provider.methods.deleteResource('france'), /Not implemented/)
})