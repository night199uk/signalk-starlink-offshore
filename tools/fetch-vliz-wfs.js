#!/usr/bin/env node
'use strict'

/*
 * Downloads a Marine Regions (VLIZ) WFS layer as a GeoJSON FeatureCollection
 * for tools/convert-world.js. The WFS caps a single response, so features are
 * paged with count/startIndex.
 *
 *   node tools/fetch-vliz-wfs.js --layer worldcountries_esri_2014 \
 *     --out geodata/vliz-land-esri-2014.geojson \
 *     [--fix "Mauritius=Republic of Mauritius,Western Sahara=Morocco"]
 *
 * Layers used by this project (all CC-BY 4.0, part of the Maritime Boundaries
 * Geodatabase):
 *   worldcountries_esri_2014   land (the normal baseline of the boundaries)
 *   eez_archipelagic_waters    archipelagic waters
 */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const WFS = 'https://geo.vliz.be/geoserver/wfs'

const args = process.argv.slice(2)
const get = (flag, dflt) => {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt
}

function parseFix (spec) {
  const map = {}
  for (const pair of String(spec || '').split(',')) {
    const [from, to] = pair.split('=')
    if (from && to) map[from.trim()] = to.trim()
  }
  return map
}

async function fetchPage (layer, start, count) {
  const url =
    `${WFS}?service=WFS&version=2.0.0&request=GetFeature&typeName=MarineRegions:${layer}` +
    `&outputFormat=application/json&srsName=EPSG:4326&sortBy=mrgid_ter1` +
    `&count=${count}&startIndex=${start}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 300000)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status} for startIndex=${start}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

async function main () {
  const layer = get('--layer', 'worldcountries_esri_2014')
  const outPath = get('--out', path.join(__dirname, '..', 'geodata', `${layer}.geojson`))
  const count = parseInt(get('--count', '10'), 10)
  const fix = parseFix(get('--fix', ''))

  const features = []
  const seen = new Set()
  let start = 0
  while (true) {
    process.stderr.write(`fetching ${layer} startIndex=${start} … `)
    const fc = await fetchPage(layer, start, count)
    const page = (fc && fc.features) || []
    for (const f of page) {
      const p = f.properties || {}
      const key = p.mrgid_ter1 != null ? `ter1:${p.mrgid_ter1}` : JSON.stringify(p)
      if (seen.has(key)) continue
      seen.add(key)
      for (const k of ['sovereign1', 'territory1']) {
        if (p[k] && fix[p[k]]) p[k] = fix[p[k]]
      }
      features.push(f)
    }
    process.stderr.write(`got ${page.length} (total ${features.length})\n`)
    if (page.length < count) break
    start += count
    if (start > 10000) break
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  const json = JSON.stringify({ type: 'FeatureCollection', features })
  if (outPath.endsWith('.gz')) fs.writeFileSync(outPath, zlib.gzipSync(Buffer.from(json, 'utf8')))
  else fs.writeFileSync(outPath, json)
  process.stderr.write(
    `wrote ${features.length} feature(s) to ${outPath} (${(fs.statSync(outPath).size / 1048576).toFixed(1)} MB)\n`
  )
}

main().catch((err) => { console.error(err); process.exit(1) })
