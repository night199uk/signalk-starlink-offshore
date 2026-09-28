#!/usr/bin/env node
'use strict'

/*
 * Command line helper to exercise the maritime zone analysis without a
 * Signal K server. Loads the two bundled whole-world datasets (territorial
 * seas, coast) and prints the current maritime zone and the jurisdiction
 * crossing forecast.
 *
 *   node bin/estimate.js --lat 49.5 --lon -4.5 --cog 235 --speed-kn 6.5
 *
 * Options:
 *   --lat <deg>        latitude (default 50)
 *   --lon <deg>        longitude (default -4)
 *   --cog <deg>        course over ground, true north (optional)
 *   --speed-kn <kn>    speed in knots (optional)
 *   --lookahead <nm>   forecast horizon in nautical miles (default 250)
 */

const path = require('path')
const fs = require('fs')
const { TerritoryStore } = require('../lib/data')
const { Zones } = require('../lib/zones')
const { analyzeCourse } = require('../lib/boundaries')

const args = process.argv.slice(2)
const get = (flag, dflt) => {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt
}

function main() {
  const lat = parseFloat(get('--lat', '50'))
  const lon = parseFloat(get('--lon', '-4'))
  const cog = args.includes('--cog') ? parseFloat(get('--cog')) : null
  const speedKn = args.includes('--speed-kn') ? parseFloat(get('--speed-kn')) : null
  const lookaheadNm = parseFloat(get('--lookahead', '250'))

  const logger = {
    debug: () => {},
    info: () => {},
    warn: (m) => console.error(m),
    error: (m) => console.error(m)
  }

  const geodataDir = path.join(__dirname, '..', 'lib', 'geodata')
  const fsExists = (file) => fs.existsSync(path.join(geodataDir, file))
  const load = (file, zoneLabel, containment) => {
    if (!fsExists(file)) return null
    const s = new TerritoryStore({
      bundledFile: path.join(geodataDir, file),
      zoneLabel,
      containment,
      logger
    })
    s.loadBundled()
    return s.features.length > 0 ? s.toBoundaries() : null
  }

  console.error('Loading bundled world datasets…')
  const zones = new Zones({
    territorialSea: load('territorial-seas-world.json.gz', 'territorial sea'),
    coast: load('coast-world.json.gz', 'coast', 'any')
  })

  if (!zones.territorialSea || zones.territorialSea.features.length === 0) {
    console.error('No bundled territorial sea dataset found')
    process.exit(1)
  }

  const zone = zones.zoneAt(lat, lon)
  const nearestNm = zones.nearestBoundaryNm(lat, lon, lookaheadNm)

  // Jurisdiction predicate: the set of countries the position is inside
  // across every layer (same semantics as the plugin's nextEvent).
  const jurisdictionAt = (la, lo) => zones.zoneAt(la, lo).countries
  const analysis =
    cog != null
      ? analyzeCourse(jurisdictionAt, lat, lon, cog, speedKn ? speedKn * 1852 / 3600 : null, {
          horizonNm: lookaheadNm,
          stepNm: 0.5
        })
      : { startCountries: jurisdictionAt(lat, lon), crossings: [] }

  const first = analysis.crossings[0] || null
  const startSet = analysis.startCountries || []
  const entry = analysis.crossings.find(
    (c) => c.countriesEntering.some((country) => !startSet.includes(country))
  ) || null
  const leave = analysis.crossings.find((c) => c.type !== 'enter') || null

  const result = {
    position: { lat, lon },
    courseDeg: cog,
    speedKnots: speedKn,
    maritimeZone: zone.zone,
    currentTerritorialSea: zone.countries.length ? zone.countries.join(', ') : '',
    insideTerritorialSea: zone.zone === 'territorial-sea',
    nextTerritorialSea: entry ? entry.countriesEntering.join(', ') : '',
    timeToNextTerritorialSea: entry ? entry.timeSeconds : null,
    distanceToNextTerritorialSea: entry ? entry.distanceNm * 1852 : null,
    nextEvent: first ? first.type : 'none',
    nextEventDistanceM: first ? first.distanceNm * 1852 : null,
    timeToLeaveTerritorialSea: leave ? leave.timeSeconds : null,
    distanceToLeaveTerritorialSea: leave ? leave.distanceNm * 1852 : null,
    territorialSeaBoundaryDistanceM: nearestNm != null ? nearestNm * 1852 : null,
    features: zones.territorialSea.features.length,
    countries: analysis.startCountries,
    crossings: analysis.crossings
  }
  console.log(JSON.stringify(result, null, 2))
}

main()