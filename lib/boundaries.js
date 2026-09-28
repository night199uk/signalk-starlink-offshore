'use strict'

/*
 * In-memory ownership of the territorial sea features plus the analysis
 * functions used by the plugin:
 *  - which countries' territorial seas contain a position
 *  - the nearest territorial sea boundary to a position
 *  - the forecast of boundary crossings ahead on the current course
 *
 * The crossing forecast is computed over an arbitrary country-containment
 * predicate, so it can run over the territorial sea layer alone or over the
 * combined jurisdiction of the plugin (territorial sea + internal waters +
 * land), where an "event" is any change in the set of countries the position
 * is inside.
 *
 * This module is deliberately free of Signal K dependencies so the crossing
 * logic can be unit tested in isolation.
 */

const { GridIndex } = require('./spatial')
const {
  destination,
  pointToSegmentNm,
  pointInRingLonLat,
  bisectCrossing,
  sameCountrySet,
  METERS_PER_NM
} = require('./geo')

// Ring whose bbox overlaps a point's tiny query box. Half size in degrees.
const CONTAIN_QUERY_HALF = 1e-6

class Boundaries {
  constructor() {
    this.rings = [] // {id, feature, lons, lats, minLat, minLon, maxLat, maxLon}
    this.features = [] // {id, country, sourceName}
    this.featuresById = new Map()
    this.index = new GridIndex()
    this.countries = [] // unique, sorted
  }

  addFeatures(internalFeatures) {
    for (const feature of internalFeatures) {
      if (this.featuresById.has(feature.id)) {
        // replace
        const old = this.featuresById.get(feature.id)
        const oldRings = this.rings.filter((r) => r.feature === old)
        for (const r of oldRings) {
          r.feature = null
        }
        old.rings = feature.rings
        this.featuresById.set(feature.id, feature)
      } else {
        this.features.push(feature)
        this.featuresById.set(feature.id, feature)
      }
    }
    this._rebuildIndex()
    this._reindexCountries()
  }

  _rebuildIndex() {
    const index = new GridIndex()
    const rings = []
    for (const feature of this.features) {
      for (const ring of feature.rings) {
        const id = rings.length
        const entry = {
          id,
          feature,
          lons: ring.lons,
          lats: ring.lats,
          minLat: ring.minLat,
          minLon: ring.minLon,
          maxLat: ring.maxLat,
          maxLon: ring.maxLon
        }
        rings.push(entry)
        index.insert(id, ring.minLat, ring.minLon, ring.maxLat, ring.maxLon)
      }
    }
    this.rings = rings
    this.index = index
  }

  _reindexCountries() {
    const set = new Set(this.features.map((f) => f.country).filter((c) => !!c))
    this.countries = Array.from(set).sort()
  }

  // Candidate rings whose bbox overlaps the query bbox.
  _queryBBox(minLat, minLon, maxLat, maxLon) {
    const result = []
    const ids = this.index.query(minLat, minLon, maxLat, maxLon)
    for (const rid of ids) {
      const ring = this.rings[rid]
      if (
        ring &&
        ring.feature &&
        ring.minLat <= maxLat &&
        ring.maxLat >= minLat &&
        ring.minLon <= maxLon &&
        ring.maxLon >= minLon
      ) {
        result.push(ring)
      }
    }
    return result
  }

  // Countries whose territorial sea contains the point. The parity rule over
  // every ring of a feature (exterior rings + holes) yields inside/outside.
  countriesAt(lat, lon) {
    const candidates = this._queryBBox(
      lat - CONTAIN_QUERY_HALF,
      lon - CONTAIN_QUERY_HALF,
      lat + CONTAIN_QUERY_HALF,
      lon + CONTAIN_QUERY_HALF
    )
    const parity = new Map()
    for (const ring of candidates) {
      if (pointInRingLonLat(lat, lon, ring.lons, ring.lats)) {
        parity.set(ring.feature, (parity.get(ring.feature) || 0) + 1)
      }
    }
    const inside = []
    for (const [feature, count] of parity) {
      if (count % 2 === 1) {
        inside.push(feature.country)
      }
    }
    return Array.from(new Set(inside))
  }

  // Distance in nautical miles from the point to the nearest territorial sea
  // boundary, regardless of course, or null when no boundary is near.
  nearestBoundaryNm(lat, lon, maxRadiusNm) {
    const maxRadiusDeg = (maxRadiusNm || 120) / 60
    const candidates = this._queryBBox(
      lat - maxRadiusDeg,
      lon - maxRadiusDeg,
      lat + maxRadiusDeg,
      lon + maxRadiusDeg
    )
    let best = null
    for (const ring of candidates) {
      // cheap bbox reject
      if (
        lat < ring.minLat - maxRadiusDeg ||
        lat > ring.maxLat + maxRadiusDeg ||
        lon < ring.minLon - maxRadiusDeg ||
        lon > ring.maxLon + maxRadiusDeg
      ) {
        continue
      }
      const { lons, lats } = ring
      for (let i = 0, j = lats.length - 1; i < lats.length; j = i++) {
        const d = pointToSegmentNm(lat, lon, lats[j], lons[j], lats[i], lons[i])
        if (best === null || d < best) best = d
      }
    }
    return best
  }

  // Forecast of boundary crossings on the current great circle course.
  //   opts: { stepNm, horizonNm, maxCrossings, sampleOffsetM }
  // Returns:
  //   {
  //     startCountries: [country,...],
  //     crossings: [
  //       {
  //         distanceNm, timeSeconds|null, type: 'enter'|'leave'|'transition',
  //         countriesLeaving: [...], countriesEntering: [...],
  //         lat, lon
  //       }
  //     ]
  //   }
  analyzeCourse(lat, lon, bearingDeg, speedMps, opts = {}) {
    return analyzeCourse(
      this.countriesAt.bind(this),
      lat,
      lon,
      bearingDeg,
      speedMps,
      opts
    )
  }
}

// Forecast of jurisdiction changes along the current great circle course for
// an arbitrary country-containment predicate `countriesAt(lat, lon)`. A
// crossing (an "event") is any change in the set of countries the point is
// inside: entering a new country ('enter'), leaving one ('leave'), or both at
// once ('transition', e.g. when passing between overlapping claims).
//   opts: { stepNm, horizonNm, maxCrossings, sampleOffsetM }
// Returns:
//   {
//     startCountries: [country,...],
//     crossings: [ { distanceNm, timeSeconds|null, type, countriesLeaving, countriesEntering, lat, lon } ]
//   }
function analyzeCourse(countriesAt, lat, lon, bearingDeg, speedMps, opts = {}) {
  const stepNm = opts.stepNm || 0.2
  const horizonNm = opts.horizonNm || 250
  const maxCrossings = opts.maxCrossings || 3
  const iterations = opts.bisectIterations || 10
  // Evaluate containment slightly to one side of the course so a sampled
  // point can never sit *exactly* on a boundary edge (which makes the
  // even-odd test ambiguous). 2 m is far below the accuracy we need.
  const offsetNm = (opts.sampleOffsetM == null ? 2 : opts.sampleOffsetM) / METERS_PER_NM
  const perpBearing = (bearingDeg + 90) % 360

  const start = countriesAt(lat, lon)
  const crossings = []

  if (bearingDeg == null || Number.isNaN(bearingDeg) || !isFinite(bearingDeg)) {
    return { startCountries: start, crossings }
  }

  let prevDist = 0
  let prevSet = start

  const stateAt = (d) => {
    const p = destination(lat, lon, bearingDeg, d)
    const q = destination(p.lat, p.lon, perpBearing, offsetNm)
    return countriesAt(q.lat, q.lon)
  }

  let d = stepNm
  while (d <= horizonNm && crossings.length < maxCrossings) {
    const set = stateAt(d)
    if (!sameCountrySet(set, prevSet)) {
      const refined = bisectCrossing(stateAt, prevDist, d, iterations)
      const p = destination(lat, lon, bearingDeg, refined.distanceNm)
      // Classify using the step-level `set` (state just past the boundary)
      // rather than `refined.set`: bisection distance may converge again onto
      // the pre-crossing side, which would yield an empty crossing.
      const entering = set.filter((c) => !prevSet.includes(c))
      const leaving = prevSet.filter((c) => !set.includes(c))

      const type = entering.length > 0 && leaving.length > 0
        ? 'transition'
        : entering.length > 0
          ? 'enter'
          : 'leave'

      let timeSeconds = null
      if (speedMps && speedMps > 0.05) {
        timeSeconds = (refined.distanceNm * METERS_PER_NM) / speedMps
      }

      crossings.push({
        distanceNm: refined.distanceNm,
        timeSeconds,
        type,
        countriesLeaving: leaving,
        countriesEntering: entering,
        lat: p.lat,
        lon: p.lon
      })

      prevSet = set
      prevDist = refined.distanceNm
    } else {
      prevSet = set
      prevDist = d
    }
    d += stepNm
    if (d > horizonNm && prevSet.length === 0 && crossings.length === 0) {
      d = horizonNm + stepNm
      break
    }
  }

  return { startCountries: start, crossings }
}

module.exports = { Boundaries, analyzeCourse }