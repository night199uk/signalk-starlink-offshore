#!/usr/bin/env node
'use strict'

/*
 * Builds the Signal K "regions" resource file from the two bundled world
 * datasets (territorial sea 12NM and the dissolved coast). One generalised,
 * display-only region per country, covering the full maritime footprint:
 * territorial sea + coast (land + internal waters + archipelagic waters).
 *
 *   node tools/build-resources.js \
 *     [--tolerance 0.02] [--min-area 0.002]
 *
 * The output is read by lib/resources.js and registered by the plugin as a
 * read-only provider for the standard 'regions' resource type, which map
 * clients such as Freeboard-SK render out of the box. The polygons are
 * generalised (Douglas-Peucker at `--tolerance` degrees, default ~2.2 km,
 * adaptively finer for small features), tiny fragments below `--min-area`
 * square degrees (~6 km2 at the equator) are dropped, and coordinates are
 * rounded; the result is display-only and never for navigation.
 */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const { simplifyRing } = require('../lib/simplify')

const GEODATA_DIR = path.join(__dirname, '..', 'lib', 'geodata')
const GEO_TS = path.join(GEODATA_DIR, 'territorial-seas-world.json.gz')
const GEO_COAST = path.join(GEODATA_DIR, 'coast-world.json.gz')

// Nicer display names for a few maritime (VLIZ) canonical names.
const DISPLAY = {
  'Comores': 'Comoros',
  'Federal Republic of Somalia': 'Somalia',
  'Republic of Mauritius': 'Mauritius',
  'Ivory Coast': "Côte d'Ivoire",
  'Sao Tome and Principe': 'São Tomé and Príncipe'
}

function canonicalMaritime(name) {
  return DISPLAY[name] || name
}

function readFeatures(file) {
  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'))
  return data.features || []
}

function slugify(name) {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'country'
  )
}

function round(v) {
  return Math.round(v * 10000) / 10000
}

// Approximate ring area in square degrees (longitudes scaled by cos(lat) so
// the result is reasonably latitude-independent). Used only to drop tiny
// display fragments, never for anything navigational.
function areaSqDeg(lons, lats) {
  const n = lons.length
  if (n < 3) return 0
  const latC = lats.reduce((a, b) => a + b, 0) / n
  const k = Math.max(Math.cos(latC * (Math.PI / 180)), 1e-6)
  let area = 0
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += (lons[j] * k) * lats[i] - (lons[i] * k) * lats[j]
  }
  return Math.abs(area) / 2
}

const SOURCES = [
  'Marine Regions (VLIZ) Territorial Seas 12NM v4 (doi:10.14284/633)',
  'Marine Regions (VLIZ) land + internal waters + archipelagic waters, dissolved (tools/build-coast.js)'
]

// Ring tolerance is adaptive: the global `toleranceDeg` applies to large
// rings, but small maritime entities (e.g. Monaco) must not be collapsed, so
// the tolerance shrinks with ring extent (min ~55 m).
function effectiveTolerance(ring, toleranceDeg) {
  const width = (ring.maxLon - ring.minLon) * Math.cos(ring.minLat * (Math.PI / 180))
  const height = ring.maxLat - ring.minLat
  const extent = Math.max(Math.abs(width), Math.abs(height))
  return Math.min(toleranceDeg, Math.max((extent || 0) * 0.02, 0.0005))
}

function build(toleranceDeg, minAreaSqDeg) {
  console.error('Reading territorial sea layer…')
  const ts = readFeatures(GEO_TS)
  console.error('Reading coast layer…')
  const coast = readFeatures(GEO_COAST)

  // Maritime countries are the only ones that get a region: the resource is
  // about offshore jurisdiction (the coast fills the footprint).
  const maritime = new Set()
  for (const f of ts) maritime.add(f.country)

  // Index each layer's rings by canonical country name.
  const ringsOf = (features, canonical) => {
    const out = new Map()
    for (const f of features) {
      const key = canonical(f.country)
      if (!key || !maritime.has(key)) continue
      let list = out.get(key)
      if (!list) {
        list = []
        out.set(key, list)
      }
      list.push(...f.rings)
    }
    return out
  }
  const tsRings = ringsOf(ts, (n) => n)
  const coastRings = ringsOf(coast, (n) => n)

  const regions = []
  let inRings = 0
  let outRings = 0
  let inVertices = 0
  let outVertices = 0

  for (const country of [...maritime].sort()) {
    const rings = [
      ...(tsRings.get(country) || []),
      ...(coastRings.get(country) || [])
    ]
    if (rings.length === 0) continue

    const polygons = []
    let west = 180
    let east = -180
    let south = 90
    let north = -90
    for (const ring of rings) {
      inRings++
      inVertices += ring.lons.length
      const simplified = simplifyRing(ring.lons, ring.lats, effectiveTolerance(ring, toleranceDeg))
      if (simplified.lons.length < 4) continue
      if (areaSqDeg(simplified.lons, simplified.lats) < minAreaSqDeg) continue
      const ringCoords = []
      for (let i = 0; i < simplified.lons.length; i++) {
        const lon = round(simplified.lons[i])
        const lat = round(simplified.lats[i])
        ringCoords.push([lon, lat])
        if (lon < west) west = lon
        if (lon > east) east = lon
        if (lat < south) south = lat
        if (lat > north) north = lat
      }
      outRings++
      outVertices += simplified.lons.length
      polygons.push([ringCoords])
    }
    if (polygons.length === 0) continue

    const name = canonicalMaritime(country)
    const id = slugify(name)
    regions.push({
      id,
      bbox: [west, south, east, north],
      resource: {
        id,
        name,
        description:
          `${name} maritime footprint: territorial sea (12 NM) and coast (land, internal and archipelagic waters). ` +
          'Generalised from the plugin\'s world boundary datasets for display only; not for navigation.',
        feature: {
          type: 'Feature',
          properties: {
            name: name,
            country: name,
            sources: SOURCES,
            informativeOnly: true
          },
          geometry: {
            type: 'MultiPolygon',
            coordinates: polygons
          }
        }
      }
    })
  }

  regions.sort((a, b) => (a.resource.name < b.resource.name ? -1 : 1))

  const payload = JSON.stringify({
    format: 1,
    description:
      'Generalised per-country maritime footprint regions (territorial sea 12NM + coast), ' +
      'display-only, built from the plugin\'s bundled world boundary datasets.',
    sources: SOURCES,
    toleranceDeg,
    minAreaSqDeg,
    savedAt: Date.now(),
    regions
  })
  const gz = zlib.gzipSync(Buffer.from(payload, 'utf8'), { level: 9 })
  fs.writeFileSync(path.join(GEODATA_DIR, 'country-regions.json.gz'), gz)
  console.error(
    `${regions.length} region(s) from ${maritime.size} maritime countr(ies); ` +
      `${outRings}/${inRings} rings, ${outVertices.toLocaleString()}/${inVertices.toLocaleString()} vertices; ` +
      `wrote ${(gz.length / 1048576).toFixed(1)} MB`
  )
  return { regions, sizeBytes: gz.length }
}

const args = process.argv.slice(2)
const get = (flag, dflt) => {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt
}
const tolerance = parseFloat(get('--tolerance', '0.02'))
const minArea = parseFloat(get('--min-area', '0.0005'))

build(tolerance, minArea)