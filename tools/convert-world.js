#!/usr/bin/env node
'use strict'

/*
 * One-time offline converter that turns a raw world boundary source - either an
 * ESRI Shapefile (the Marine Regions / VLIZ territorial sea and internal waters
 * downloads) or a GeoJSON FeatureCollection (the VLIZ land and archipelagic
 * waters WFS layers downloaded by tools/fetch-vliz-wfs.js) - into the plugin's
 * internal, gzip-compressed world cache.
 *
 * The plugin ships with the converted caches (`lib/geodata/*.json.gz`) so it
 * works fully offline; this script only needs to be re-run when a new dataset
 * version is released.
 *
 *   # Marine Regions (VLIZ) shapefiles
 *   node tools/convert-world.js \
 *     --shp ./geodata/World_12NM_v4_20231025/eez_12nm_v4.shp \
 *     [--out ./lib/geodata/territorial-seas-world.json.gz] \
 *     [--precision 5]
 *
 *   # VLIZ WFS layers (GeoJSON, after tools/fetch-vliz-wfs.js)
 *   node tools/convert-world.js \
 *     --geojson ./geodata/vliz-land-esri-2014.geojson \
 *     --out ./geodata/land-world.json.gz
 *
 * The source files come from https://www.marineregions.org/downloads.php
 * (Territorial Seas 12NM v4, doi:10.14284/633; World Internal Waters v4,
 * doi:10.14284/631; World Countries 2014 land, CC-BY 4.0).
 */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const { convertFeatureCollection, NAME_KEYS } = require('../lib/features')

const args = process.argv.slice(2)
const get = (flag, dflt) => {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt
}

async function main() {
  const shpPath = get('--shp')
  const geoPath = get('--geojson')
  const outPath = get('--out', path.join(__dirname, '..', 'lib', 'geodata', 'territorial-seas-world.json.gz'))
  const precision = parseInt(get('--precision', '5'), 10)

  const haveShp = shpPath && fs.existsSync(shpPath)
  const haveGeo = geoPath && fs.existsSync(geoPath)
  if (!haveShp && !haveGeo) {
    console.error(
      'Usage: node tools/convert-world.js (--shp <shapefile> | --geojson <feature-collection>) ' +
        '[--out <gz>] [--precision <n>]'
    )
    process.exit(1)
  }

  const p10 = Math.pow(10, precision)
  const round = (v) => Math.round(v * p10) / p10

  const features = []
  let outId = 0

  // Post-process a batch of converted features: give anonymous ids a unique
  // global id (so later `addFeatures` upserts keep every feature), round the
  // coordinates to `precision` and recompute each ring's bbox.
  const push = (converted) => {
    for (const f of converted) {
      // Feature ids come from the source `mrgid` when present (VLIZ layers).
      // Datasets without it fall back to `feature-<index>`, which is always
      // `feature-0` for a single-record conversion; give those a unique global
      // id instead so id collisions don't collapse features in Boundaries.
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
      }
      features.push(f)
    }
  }

  if (haveGeo) {
    console.error(`Reading ${geoPath}…`)
    const geo = JSON.parse(fs.readFileSync(geoPath, 'utf8'))
    const source = Array.isArray(geo) ? geo : geo.features || []
    push(convertFeatureCollection(source, NAME_KEYS))
  } else {
    // Lazy so the shapefile library is only needed for shapefile builds.
    const shapefile = require('shapefile')
    console.error(`Reading ${shpPath}…`)
    const source = await shapefile.open(shpPath)
    let total = 0
    while (true) {
      const r = await source.read()
      if (r.done) break
      const feature = r.value
      if (!feature) continue
      total++
      push(convertFeatureCollection([feature], NAME_KEYS))
      if (total % 25 === 0) console.error(`...${total} source features read`)
    }
    console.error(`${total} source feature(s) read`)
  }

  let rings = 0
  let vertices = 0
  for (const f of features) {
    for (const ring of f.rings) {
      rings++
      vertices += ring.lons.length
    }
  }
  console.error(`${features.length} internal feature(s), ${rings} ring(s), ${vertices} vertex(es)`)

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
