#!/usr/bin/env node
'use strict'

/*
 * One-time offline converter that turns the Marine Regions (VLIZ) Territorial
 * Seas (12NM) v4 ESRI Shapefile into the plugin's internal, gzip-compressed
 * world cache.
 *
 * The plugin ships with the converted cache (`lib/geodata/territorial-seas-world.json.gz`)
 * so it works fully offline; this script only needs to be re-run when a new
 * dataset version is released.
 *
 *   node tools/convert-world.js \
 *     --shp ./geodata/World_12NM_v4_20231025/eez_12nm_v4.shp \
 *     [--out ./lib/geodata/territorial-seas-world.json.gz] \
 *     [--precision 5]
 *
 * The source file comes from https://www.marineregions.org/downloads.php#marbound
 * (World 12 Nautical Miles Zone (Territorial Seas) v4, doi:10.14284/633,
 * CC-BY 4.0).
 */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const shapefile = require('shapefile')

const { convertFeatureCollection, NAME_KEYS } = require('../lib/features')

const args = process.argv.slice(2)
const get = (flag, dflt) => {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt
}

async function main() {
  const shpPath = get('--shp')
  const outPath = get('--out', path.join(__dirname, '..', 'lib', 'geodata', 'territorial-seas-world.json.gz'))
  const precision = parseInt(get('--precision', '5'), 10)
  if (!shpPath || !fs.existsSync(shpPath)) {
    console.error('Usage: node tools/convert-world.js --shp <path-to-eez_12nm_v4.shp> [--out <gz>] [--precision <n>]')
    process.exit(1)
  }
  const p10 = Math.pow(10, precision)
  const round = (v) => Math.round(v * p10) / p10

  console.error(`Reading ${shpPath}…`)
  const source = await shapefile.open(shpPath)

  const features = []
  let outId = 0
  let total = 0
  let rings = 0
  let vertices = 0
  while (true) {
    const r = await source.read()
    if (r.done) break
    const feature = r.value
    if (!feature) continue
    total++
    const converted = convertFeatureCollection([feature], NAME_KEYS)
    for (const f of converted) {
      // Feature ids come from the source `mrgid` when present (VLIZ layers).
      // Datasets without it (Natural Earth) fall back to `feature-<index>`,
      // which is always `feature-0` for a single-record conversion; give those
      // a unique global id instead so later `addFeatures` upserts keep every
      // feature (id collisions collapse to one feature in Boundaries).
      if (/^feature-\d+$/.test(f.id)) f.id = `feature-${outId++}`
      for (const ring of f.rings) {
        for (let i = 0; i < ring.lons.length; i++) {
          ring.lons[i] = round(ring.lons[i])
          ring.lats[i] = round(ring.lats[i])
        }
        // recompute bbox after rounding
        let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180
        for (let i = 0; i < ring.lats.length; i++) {
          if (ring.lats[i] < minLat) minLat = ring.lats[i]
          if (ring.lats[i] > maxLat) maxLat = ring.lats[i]
          if (ring.lons[i] < minLon) minLon = ring.lons[i]
          if (ring.lons[i] > maxLon) maxLon = ring.lons[i]
        }
        ring.minLat = minLat
        ring.maxLat = maxLat
        ring.minLon = minLon
        ring.maxLon = maxLon
        rings++
        vertices += ring.lons.length
      }
      features.push(f)
    }
    if (total % 25 === 0) console.error(`...${total} source features read`)
  }

  console.error(`${total} source feature(s) -> ${features.length} internal feature(s), ${rings} ring(s), ${vertices} vertex(es)`)

  const payload = JSON.stringify({
    format: 1,
    savedAt: Date.now(),
    allCovered: true,
    fullFetchedAt: Date.now(),
    tiles: {},
    features
  })
  const gz = zlib.gzipSync(Buffer.from(payload, 'utf8'))
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, gz)
  console.error(`wrote ${outPath} (${(gz.length / 1048576).toFixed(1)} MB)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})