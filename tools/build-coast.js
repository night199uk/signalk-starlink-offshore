#!/usr/bin/env node
'use strict'

/*
 * Builds the plugin's bundled "coast" layer - everything landward of the
 * territorial sea's normal/straight baselines, i.e. land + internal waters +
 * archipelagic waters - by dissolving the three VLIZ source layers into one
 * polygon set per country.
 *
 *   node tools/build-coast.js [--inputs geodata] \
 *     [--out lib/geodata/coast-world.json.gz]
 *
 * Inputs (converted by tools/convert-world.js, kept out of the shipped lib/):
 *   geodata/internal-waters-world.json.gz
 *   geodata/land-world.json.gz
 *   geodata/archipelagic-waters-world.json.gz
 *
 * Why dissolve: the three sources are adjacent and share coastlines. Kept
 * separate, their slightly different digitalisations leave thin slivers where
 * a position falls between layers (reported as high seas). Unioning each
 * country's rings removes those internal seams and collapses the shared
 * coastline, which also makes the layer much smaller.
 *
 * Robustness: polygon-clipping's sweep fails on the largest inputs (Canada has
 * ~100k rings; other big countries have very dense coastlines). So we first
 * union a country whole, retrying with progressively coarser Douglas-Peucker
 * simplification of the inputs. If that still fails (Canada), the country's
 * rings are partitioned into 5-degree cells, dissolved per cell, and
 * concatenated. The result is a single multi-polygon per country that is
 * consumed with "inside any ring" semantics (so per-cell overlaps are
 * harmless).
 */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const pc = require('polygon-clipping')

const { simplifyRing } = require('../lib/simplify')

const REPO = path.join(__dirname, '..')
const args = process.argv.slice(2)
const get = (flag, dflt) => {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt
}
const inputsDir = get('--inputs', path.join(REPO, 'geodata'))
const outPath = get('--out', path.join(REPO, 'lib', 'geodata', 'coast-world.json.gz'))

const SOURCES = {
  territorial: 'territorial-seas-world.json.gz',
  internal: 'internal-waters-world.json.gz',
  land: 'land-world.json.gz',
  archipelagic: 'archipelagic-waters-world.json.gz'
}

function readFeatures (file) {
  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'))
  return data.features || []
}

function byCountry (features) {
  const m = new Map()
  for (const f of features) {
    if (!f.country) continue
    let a = m.get(f.country)
    if (!a) { a = []; m.set(f.country, a) }
    for (const r of f.rings) a.push(r)
  }
  return m
}

function toPoly (r, tol) {
  let lons = r.lons
  let lats = r.lats
  if (tol > 0) { const s = simplifyRing(lons, lats, tol); lons = s.lons; lats = s.lats }
  if (lons.length < 3) return null
  const ring = []
  for (let i = 0; i < lons.length; i++) ring.push([lons[i], lats[i]])
  ring.push([lons[0], lats[0]])
  return [ring]
}

function tryUnion (rings, tols) {
  for (const tol of tols) {
    const polys = rings.map((r) => toPoly(r, tol)).filter(Boolean)
    if (polys.length === 0) return []
    try { return pc.union(...polys) } catch (err) { /* retry coarser */ }
  }
  return null
}

const WHOLE_TOLS = [0, 0.0005, 0.001, 0.002, 0.005]
const CELL_TOLS = [0, 0.001, 0.003, 0.01]
const CELL_DEG = 5

function buildCountry (rings) {
  const whole = tryUnion(rings, WHOLE_TOLS)
  if (whole) return { merged: whole, grid: false, failed: 0 }
  // Partition into 5-degree cells and dissolve each independently.
  const groups = new Map()
  for (const r of rings) {
    const cx = (r.minLon + r.maxLon) / 2
    const cy = (r.minLat + r.maxLat) / 2
    const key = `${Math.floor(cx / CELL_DEG)},${Math.floor(cy / CELL_DEG)}`
    let g = groups.get(key)
    if (!g) { g = []; groups.set(key, g) }
    g.push(r)
  }
  const out = []
  let failed = 0
  for (const g of groups.values()) {
    const m = tryUnion(g, CELL_TOLS)
    if (m) out.push(...m)
    else failed++
  }
  return { merged: out, grid: true, failed }
}

function main () {
  const iw = byCountry(readFeatures(path.join(inputsDir, SOURCES.internal)))
  const land = byCountry(readFeatures(path.join(inputsDir, SOURCES.land)))
  const aw = byCountry(readFeatures(path.join(inputsDir, SOURCES.archipelagic)))
  const maps = [iw, land, aw]

  const countries = new Set()
  for (const m of maps) for (const c of m.keys()) countries.add(c)

  const features = []
  const gridCountries = []
  let totalRings = 0
  let totalVerts = 0
  const t0 = Date.now()
  for (const country of [...countries].sort()) {
    const rings = []
    for (const m of maps) if (m.has(country)) rings.push(...m.get(country))
    if (rings.length === 0) continue
    const { merged, grid, failed } = buildCountry(rings)
    if (grid) gridCountries.push(failed ? `${country}(+${failed}failed)` : country)
    const outRings = []
    let west = 180, east = -180, south = 90, north = -90
    for (const poly of merged) {
      for (const ring of poly) {
        const lons = new Array(ring.length)
        const lats = new Array(ring.length)
        let rW = 180, rE = -180, rS = 90, rN = -90
        for (let i = 0; i < ring.length; i++) {
          const lon = Math.round(ring[i][0] * 1e5) / 1e5
          const lat = Math.round(ring[i][1] * 1e5) / 1e5
          lons[i] = lon
          lats[i] = lat
          if (lon < rW) rW = lon; if (lon > rE) rE = lon
          if (lat < rS) rS = lat; if (lat > rN) rN = lat
        }
        if (lons.length < 3) continue
        if (rW < west) west = rW; if (rE > east) east = rE
        if (rS < south) south = rS; if (rN > north) north = rN
        totalRings++
        totalVerts += lons.length
        outRings.push({ lons, lats, minLon: rW, maxLon: rE, minLat: rS, maxLat: rN })
      }
    }
    if (outRings.length === 0) continue
    features.push({
      id: country,
      country,
      sourceName: country,
      rings: outRings,
      bbox: [west, south, east, north]
    })
  }

  const payload = JSON.stringify({
    format: 1,
    savedAt: Date.now(),
    allCovered: true,
    features
  })
  const gz = zlib.gzipSync(Buffer.from(payload, 'utf8'), { level: 9 })
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, gz)
  console.error(
    `${features.length} coast countr(ies); ${totalRings} rings, ${totalVerts.toLocaleString()} vertices; ` +
      `grid fallback: ${gridCountries.join(', ') || 'none'}; wrote ${(gz.length / 1048576).toFixed(1)} MB (${Date.now() - t0} ms)`
  )
}

main()
