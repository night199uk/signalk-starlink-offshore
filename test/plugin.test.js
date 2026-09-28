'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const factory = require('../index.js')

function makeApp(opts = {}) {
  // Fake SubscriptionManager: records which paths were subscribed and lets the
  // test push synthetic deltas. Set opts.legacy to emulate an old server with
  // only app.streambundle.getSelfStream().
  const registrations = new Map() // path -> array of delta callbacks
  const msgs = []
  const errors = []
  const providers = [] // resource providers registered by the plugin

  const register = (path, callback) => {
    const callbacks = registrations.get(path) || []
    callbacks.push(callback)
    registrations.set(path, callbacks)
  }

  const app = {
    selfId: 'foo',
    debug: () => {},
    error: (m) => errors.push(String(m)),
    setPluginStatus: () => {},
    handleMessage: (from, msg) => msgs.push(msg),
    registerResourceProvider: (provider) => providers.push(provider),
    streambundle: opts.legacy
      ? {
          getSelfStream: (path) => ({
            onValue: (cb) => {
              register(path, cb)
              return () => {}
            }
          })
        }
      : {
          getSelfStream: () => {
            throw new Error('legacy streambundle API should not be used')
          }
        },
    subscriptionmanager: opts.legacy
      ? undefined
      : {
          subscribe: (command, unsubscribes, errorCallback, callback) => {
            for (const s of command.subscribe || []) {
              if (!s || !s.path) continue
              register(s.path, callback)
              unsubscribes.push(() => {})
            }
          }
        }
  }

  const push = (path, value) => {
    const delta = {
      context: 'self',
      updates: [{ $source: 'test', values: [{ path, value }] }]
    }
    // The legacy streambundle API hands raw values to the callback; the
    // SubscriptionManager hands deltas.
    for (const callback of registrations.get(path) || []) {
      if (opts.legacy) callback(value)
      else callback(delta)
    }
  }

  const subscribedPaths = () => [...registrations.keys()]

  const values = (d) =>
    (d.updates || []).reduce(
      (acc, u) => acc.concat((u.values || []).map((v) => ({ path: v.path, value: v.value }))),
      []
    )

  const navValues = () => {
    const nav = {}
    for (const msg of msgs) {
      for (const { path: p, value } of values(msg)) {
        if (p && !p.startsWith('notifications.')) nav[p] = value
      }
    }
    return nav
  }

  return { app, msgs, errors, providers, push, values, navValues, subscribedPaths }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function bundledLoaded() {
  return fs.existsSync(path.join(__dirname, '..', 'lib', 'geodata', 'territorial-seas-world.json.gz'))
}

function startBundled(t, make) {
  const ctx = make()
  const plugin = factory(ctx.app)
  t.after(() => {
    plugin.stop()
  })
  const ok = plugin.start({
    computeIntervalSeconds: 1
  })
  assert.strictEqual(ok, true)
  return { ...ctx, plugin }
}

function resourcesFileBuilt() {
  return fs.existsSync(path.join(__dirname, '..', 'lib', 'geodata', 'country-regions.json.gz'))
}

test('subscribes through subscriptionmanager and computeNow publishes outputs', async (t) => {
  if (!bundledLoaded()) return t.skip('bundled dataset not built')
  const ctx = startBundled(t, makeApp)

  assert.ok(ctx.subscribedPaths().length >= 8, 'all self streams subscribed')
  assert.ok(ctx.subscribedPaths().includes('navigation.position'))

  ctx.push('navigation.position', { latitude: 43.1, longitude: 5.1 })
  ctx.push('navigation.courseOverGroundTrue', (270 * Math.PI) / 180)
  ctx.push('navigation.speedOverGround', (6 * 1852) / 3600)

  await sleep(1600) // let the compute interval fire at least once

  assert.deepStrictEqual(ctx.errors, [], `plugin emitted errors: ${ctx.errors.join('; ')}`)

  const nav = ctx.navValues()
  assert.strictEqual(nav['navigation.insideTerritorialSea'], true)
  assert.strictEqual(nav['navigation.currentTerritorialSea'], 'France')
  assert.strictEqual(nav['navigation.maritimeZone'], 'territorial-sea')
  assert.strictEqual(nav['navigation.onLand'], false)
  assert.strictEqual(nav['navigation.territorialSeaCountries'], undefined, 'territorialSeaCountries removed')

  const notif = ctx.msgs.flatMap(ctx.values).find((v) => v.path === 'notifications.starlinkOffshore.dataStatus')
  assert.ok(notif, 'dataStatus notification present')
  assert.match(notif.value.message, /Boundary data loaded/)

  // computeNow must have run at least once: outputs only exist after it does.
  assert.ok(
    Object.keys(nav).length >= 5,
    `expected navigation outputs, got ${Object.keys(nav).join(', ')}`
  )
})

test('computeNow re-runs on the interval and picks up changed positions', async (t) => {
  if (!bundledLoaded()) return t.skip('bundled dataset not built')
  const ctx = startBundled(t, makeApp)

  // Inside Marseille; wait for the first compute cycle.
  ctx.push('navigation.position', { latitude: 43.1, longitude: 5.1 })
  await sleep(1600)
  assert.strictEqual(ctx.navValues()['navigation.insideTerritorialSea'], true)

  // Move to high seas; a subsequent timer tick must recompute and publish the
  // change without requiring a fresh delta-driven event.
  ctx.push('navigation.position', { latitude: 52, longitude: -30 })
  await sleep(1600)
  assert.strictEqual(ctx.navValues()['navigation.insideTerritorialSea'], false)
  assert.deepStrictEqual(ctx.errors, [])

  const publishCount = ctx.msgs.filter((m) =>
    (m.updates || []).some((u) => (u.values || []).some((v) => v.path === 'navigation.insideTerritorialSea'))
  ).length
  assert.ok(publishCount >= 2, `expected true+false publishes, got ${publishCount}`)
})

test('high-seas position runs without errors', async (t) => {
  if (!bundledLoaded()) return t.skip('bundled dataset not built')
  const ctx = startBundled(t, makeApp)
  ctx.push('navigation.position', { latitude: 52, longitude: -30 })
  await sleep(1200)
  assert.deepStrictEqual(ctx.errors, [])
  assert.strictEqual(ctx.navValues()['navigation.insideTerritorialSea'], false)
})

test('falls back to legacy streambundle API when subscriptionmanager is absent', async (t) => {
  if (!bundledLoaded()) return t.skip('bundled dataset not built')
  const ctx = startBundled(t, () => makeApp({ legacy: true }))

  assert.ok(ctx.subscribedPaths().includes('navigation.position'), 'legacy getSelfStream used')

  ctx.push('navigation.position', { latitude: 43.1, longitude: 5.1 })
  ctx.push('navigation.courseOverGroundTrue', (270 * Math.PI) / 180)
  ctx.push('navigation.speedOverGround', (6 * 1852) / 3600)
  await sleep(1600)

  assert.deepStrictEqual(ctx.errors, [], `emitted errors: ${ctx.errors.join('; ')}`)
  assert.strictEqual(ctx.navValues()['navigation.insideTerritorialSea'], true)
})

test('registers a read-only regions resource provider', async (t) => {
  if (!resourcesFileBuilt()) return t.skip('country regions resource file not built')
  const ctx = startBundled(t, makeApp)

  const provider = ctx.providers.find((p) => p.type === 'regions')
  assert.ok(provider, 'regions resource provider registered')
  assert.ok(provider.count > 100, `expected many regions, got ${provider.count}`)

  const all = await provider.methods.listResources({})
  assert.ok(Object.keys(all).length === provider.count, 'listResources returns every region')
  assert.ok(all.colombia, 'Colombia region present')
  assert.strictEqual(all.colombia.feature.geometry.type, 'MultiPolygon')

  const comoros = await provider.methods.listResources({ bbox: '42,-13,46,-11' })
  assert.ok(comoros.comoros && !comoros.colombia, 'bbox-filtered list still finds Comoros')

  const res = await provider.methods.getResource('colombia')
  assert.strictEqual(res.name, 'Colombia')
  await assert.rejects(() => provider.methods.setResource('colombia', {}), /Not implemented/)
  await assert.rejects(() => provider.methods.deleteResource('colombia'), /Not implemented/)
  assert.deepStrictEqual(ctx.errors, [], `plugin emitted errors: ${ctx.errors.join('; ')}`)
})

test('zones classify bay, land and high seas correctly (Cartagena scenario)', async (t) => {
  if (!bundledLoaded()) return t.skip('bundled dataset not built')
  const ctx = startBundled(t, makeApp)

  // The vessel inside Cartagena bay: VLIZ models the territorial sea as the
  // 12 NM belt seaward of the baselines, so the bay is landward of them and is
  // reported as coast (onLand), not territorial sea. currentTerritorialSea
  // still names the country.
  ctx.push('navigation.position', { latitude: 10.416582624299975, longitude: -75.54658745563728 })
  await sleep(1200)
  let nav = ctx.navValues()
  assert.strictEqual(nav['navigation.maritimeZone'], 'land')
  assert.strictEqual(nav['navigation.currentTerritorialSea'], 'Colombia')
  assert.strictEqual(nav['navigation.insideTerritorialSea'], false)
  assert.strictEqual(nav['navigation.onLand'], true)
  assert.strictEqual(nav['navigation.maritimeZoneCountries'], undefined, 'maritimeZoneCountries removed')

  // On the Cartagena city landmass -> coast of Colombia.
  ctx.push('navigation.position', { latitude: 10.391, longitude: -75.479 })
  await sleep(1200)
  nav = ctx.navValues()
  assert.strictEqual(nav['navigation.onLand'], true)
  assert.strictEqual(nav['navigation.maritimeZone'], 'land')
  assert.strictEqual(nav['navigation.currentTerritorialSea'], 'Colombia')
  assert.strictEqual(nav['navigation.insideTerritorialSea'], false)

  // Mid-Atlantic -> high seas, no country.
  ctx.push('navigation.position', { latitude: 52, longitude: -30 })
  await sleep(1200)
  nav = ctx.navValues()
  assert.strictEqual(nav['navigation.maritimeZone'], 'high-seas')
  assert.strictEqual(nav['navigation.currentTerritorialSea'], '')
  assert.strictEqual(nav['navigation.insideTerritorialSea'], false)
  assert.strictEqual(nav['navigation.onLand'], false)
  assert.deepStrictEqual(ctx.errors, [])
})

test('nextEvent reflects jurisdiction semantics, not territorial sea polygons alone', async (t) => {
  if (!bundledLoaded()) return t.skip('bundled dataset not built')
  const ctx = startBundled(t, makeApp)

  // The vessel is on Colombia's coast (Cartagena bay). The first jurisdiction
  // change on this coastal course must involve LEAVING Colombia: at the
  // Colombia/Venezuela border the set changes from {Colombia} to {Venezuela}
  // in one step, i.e. a 'transition' (leave Colombia, enter Venezuela) and the
  // next new country is Venezuela. The old TS-polygon-only forecast reported
  // entering Venezuela while still inside Colombia; before the coast layer
  // shared the maritime layers' coastline, a coastal gap first produced a
  // phantom 'leave' into high seas.
  ctx.push('navigation.position', { latitude: 10.416490769348695, longitude: -75.54663001887337 })
  ctx.push('navigation.courseOverGroundTrue', (75 * Math.PI) / 180)
  await sleep(1600)

  const nav = ctx.navValues()
  assert.strictEqual(nav['navigation.maritimeZone'], 'land')
  assert.strictEqual(nav['navigation.currentTerritorialSea'], 'Colombia')
  assert.strictEqual(nav['navigation.nextEvent'], 'transition')
  assert.strictEqual(nav['navigation.nextTerritorialSea'], 'Venezuela')
  assert.ok(nav['navigation.nextEventDistanceM'] > 0, 'distance to first jurisdiction change present')
  assert.deepStrictEqual(ctx.errors, [])
})