'use strict'

/*
 * Geodesy helpers used by the plugin.
 *
 * All bearings are in degrees from true north, measured clockwise.
 * Distances are in nautical miles unless otherwise stated.
 * No external dependencies - just spherical trig.
 */

const METERS_PER_NM = 1852
const EARTH_RADIUS_M = 6371000
const EARTH_RADIUS_NM = EARTH_RADIUS_M / METERS_PER_NM
const DEG = Math.PI / 180

function toRad(deg) {
  return deg * DEG
}

function toDeg(rad) {
  return rad / DEG
}

function toNm(meters) {
  return meters / METERS_PER_NM
}

// Clamp an angle to [0, 360)
function normalizeDeg(deg) {
  const d = ((deg % 360) + 360) % 360
  return d
}

// Signal K stores angles in radians but some providers emit degrees.
// Accept either and always return radians.
function toRadians(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (Math.abs(value) > Math.PI * 2) {
    return toRad(value)
  }
  return value
}

// Great circle distance in meters (haversine)
function haversineM(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1)
  const phi2 = toRad(lat2)
  const dPhi = toRad(lat2 - lat1)
  const dLambda = toRad(lon2 - lon1)
  const a =
    Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) * Math.sin(dLambda / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return EARTH_RADIUS_M * c
}

function haversineNm(lat1, lon1, lat2, lon2) {
  return toNm(haversineM(lat1, lon1, lat2, lon2))
}

// Initial great circle bearing from p1 to p2, degrees 0..360
function initialBearingDeg(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1)
  const phi2 = toRad(lat2)
  const dLambda = toRad(lon2 - lon1)
  const y = Math.sin(dLambda) * Math.cos(phi2)
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda)
  return normalizeDeg(toDeg(Math.atan2(y, x)))
}

// Destination point given start, initial bearing (deg) and distance (nm)
function destination(lat, lon, bearingDeg, distanceNm) {
  const phi1 = toRad(lat)
  const lambda1 = toRad(lon)
  const brng = toRad(bearingDeg)
  const d = distanceNm / EARTH_RADIUS_NM
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(d) +
      Math.cos(phi1) * Math.sin(d) * Math.cos(brng)
  )
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(phi1),
      Math.cos(d) - Math.sin(phi1) * Math.sin(phi2)
    )
  let lon2 = ((toDeg(lambda2) + 180) % 360) - 180
  if (lon2 === -180 && lambda2 > 0) lon2 = 180
  return { lat: toDeg(phi2), lon: lon2 }
}

// Distance in meters from a point to the great circle segment [a, b].
// Falls back to the nearest endpoint if the perpendicular foot is outside
// the segment.
function pointToSegmentM(lat, lon, aLat, aLon, bLat, bLon) {
  const d13 = haversineM(aLat, aLon, lat, lon)
  const d12 = haversineM(aLat, aLon, bLat, bLon)
  if (d12 < 1e-9) {
    return d13
  }
  const brng13 = initialBearingDeg(aLat, aLon, lat, lon)
  const brng12 = initialBearingDeg(aLat, aLon, bLat, bLon)
  const dTheta = toRad(brng13 - brng12)

  const crossTrack =
    Math.asin(Math.sin(d13 / EARTH_RADIUS_M) * Math.sin(dTheta)) *
    EARTH_RADIUS_M

  // along-track distance from a, clamped to [0, d12]
  const alongTrack =
    Math.acos(Math.cos(d13 / EARTH_RADIUS_M) / Math.cos(crossTrack / EARTH_RADIUS_M)) *
    EARTH_RADIUS_M

  if (alongTrack < 0) {
    return d13
  }
  if (alongTrack > d12) {
    return haversineM(bLat, bLon, lat, lon)
  }
  return Math.abs(crossTrack)
}

function pointToSegmentNm(lat, lon, aLat, aLon, bLat, bLon) {
  return toNm(pointToSegmentM(lat, lon, aLat, aLon, bLat, bLon))
}

// Even-odd ray casting test. ring must be a closed loop of [[lat,lon],...]
// with no edge spanning more than 180 degrees of longitude (see feature
// normalization which splits rings at the antimeridian).
function pointInRing(lat, lon, ring) {
  let inside = false
  const n = ring.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][1]
    const yi = ring[i][0]
    const xj = ring[j][1]
    const yj = ring[j][0]
    if (yi > lat !== yj > lat) {
      const xint = ((xj - xi) * (lat - yi)) / (yj - yi) + xi
      if (lon < xint) {
        inside = !inside
      }
    }
  }
  return inside
}

// Fast even-odd test over parallel latitude/longitude arrays (already in
// lon/lat plane in [-180,180] with no edge spanning more than 180 degrees).
function pointInRingLonLat(lat, lon, lons, lats) {
  let inside = false
  const n = lats.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = lons[i]
    const yi = lats[i]
    const xj = lons[j]
    const yj = lats[j]
    if (yi > lat !== yj > lat) {
      const xint = ((xj - xi) * (lat - yi)) / (yj - yi) + xi
      if (lon < xint) {
        inside = !inside
      }
    }
  }
  return inside
}

// Refine a crossing found between loDist and hiDist where the country set
// changes somewhere strictly between them.
function bisectCrossing(fn, loDist, hiDist, iterations) {
  let lo = loDist
  let hi = hiDist
  let loSet = fn(lo)
  let set = null
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2
    set = fn(mid)
    if (sameCountrySet(set, loSet)) {
      lo = mid
    } else {
      hi = mid
    }
  }
  return { distanceNm: hi, set }
}

function sameCountrySet(a, b) {
  if (!a || !b) return a === b
  if (a.length !== b.length) return false
  const bb = new Set(b)
  return a.every((c) => bb.has(c))
}

module.exports = {
  METERS_PER_NM,
  EARTH_RADIUS_M,
  EARTH_RADIUS_NM,
  toRad,
  toDeg,
  toNm,
  normalizeDeg,
  toRadians,
  haversineM,
  haversineNm,
  initialBearingDeg,
  destination,
  pointToSegmentM,
  pointToSegmentNm,
  pointInRing,
  pointInRingLonLat,
  bisectCrossing,
  sameCountrySet
}