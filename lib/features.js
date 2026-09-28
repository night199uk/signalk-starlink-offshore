'use strict'

/*
 * Converts raw GeoJSON territorial sea features into the compact, indexable
 * internal representation used by the plugin.
 *
 * Each output feature looks like:
 * {
 *   id: <provider id or generated>,
 *   country: <normalised country name>,
 *   sourceName: <original name from the dataset>,
 *   rings: [ { lons:[], lats:[], minLat, minLon, maxLat, maxLon } ]
 * }
 *
 * Rings are split at the antimeridian so that no single ring edge spans more
 * than 180 degrees of longitude (required by the point-in-ring test and the
 * spatial index).
 */

const { normalizeCountryName } = require('./names')

// Property keys (in order of preference) that hold the country name. The VLIZ
// shapefile ships clean names in SOVEREIGN1 ("United Kingdom") and adjectival
// ones in GEONAME ("British 12 NM").
const NAME_KEYS = ['SOVEREIGN1', 'sovereign1', 'GEONAME', 'geoname', 'NAME', 'territory1', 'TERRITORY1']

function closeRing(pts) {
  if (pts.length < 3) return null
  // drop duplicate closing point if present
  if (pts.length > 1) {
    const a = pts[0]
    const b = pts[pts.length - 1]
    if (Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12) {
      pts.pop()
    }
  }
  if (pts.length < 3) return null
  return pts
}

// Split a raw ring (array of [lat, lon]) into sub-rings whose edges do not
// cross the antimeridian. Handles the common case of a ring crossing the
// antimeridian exactly twice (one leg out, one leg back - typical of Pacific
// island territorial seas). Rings with any other number of crossings are
// returned unchanged.
function splitAntimeridian(ring) {
  const n = ring.length - 1 // ignore closing duplicate
  const crossings = []
  for (let i = 0; i < n; i++) {
    const lon1 = ring[i][1]
    const lon2 = ring[i + 1][1]
    if (Math.abs(lon2 - lon1) <= 180) continue
    const targetLon = lon2 > lon1 ? 180 : -180
    const f = (targetLon - lon1) / (lon2 - lon1)
    const latX = ring[i][0] + (ring[i + 1][0] - ring[i][0]) * f
    crossings.push({ lat: latX, lon: targetLon, i })
  }

  if (crossings.length !== 2) {
    // No dateline crossing (or an unusual one); ring is either fully on one
    // side already or too tangled to split safely.
    const pts = ring.slice(0, n)
    if (pts.length < 3) return []
    return [pts]
  }

  const [cA, cB] = crossings
  const rings = []

  // Sub-ring 1: from crossing A forward (following ring order) to crossing B.
  // Sub-ring 2: the complementary arc from B back to A.
  for (const [start, end] of [[cA, cB], [cB, cA]]) {
    const sub = []
    // First crossing point, mapped to the side of the arc it opens.
    const side = start.lon > 0 ? 180 : -180
    sub.push([start.lat, side])
    let j = (start.i + 1) % n
    while (j !== end.i) {
      sub.push([ring[j][0], ring[j][1]])
      j = (j + 1) % n
    }
    sub.push([ring[end.i][0], ring[end.i][1]])
    // Closing corner shares the arc's meridian so the closing edge stays
    // short (< 180 degrees of longitude).
    sub.push([end.lat, side])
    const closed = closeRing(sub)
    if (closed) rings.push(closed)
  }
  return rings
}

function ringToArrays(pts) {
  const lons = new Array(pts.length)
  const lats = new Array(pts.length)
  let minLat = 90
  let maxLat = -90
  let minLon = 180
  let maxLon = -180
  for (let i = 0; i < pts.length; i++) {
    const lat = pts[i][0]
    const lon = pts[i][1]
    lats[i] = lat
    lons[i] = lon
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
  }
  return { lons, lats, minLat, minLon, maxLat, maxLon }
}

function convertGeometry(country, sourceName, geometry) {
  const rings = []
  if (!geometry) return rings
  if (geometry.type === 'Polygon') {
    for (const poly of geometry.coordinates) {
      for (const sub of splitAntimeridian(poly.map(([lon, lat]) => [lat, lon]))) {
        rings.push(ringToArrays(sub))
      }
    }
  } else if (geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates) {
      for (const ring of poly) {
        for (const sub of splitAntimeridian(ring.map(([lon, lat]) => [lat, lon]))) {
          rings.push(ringToArrays(sub))
        }
      }
    }
  }
  return rings
}

function featureId(properties, index) {
  return String(
    properties && (properties.mrgid != null ? properties.mrgid : properties.MRGID != null ? properties.MRGID : properties.geoname || properties.GEONAME || `feature-${index}`)
  )
}

// Convert a GeoJSON FeatureCollection (or array of features) into internal
// features. `order` is a list of candidate property keys for the raw name,
// e.g. ['GEONAME', 'geoname', 'sovereign1', 'territory1'].
function convertFeatureCollection(geojson, order) {
  const features = Array.isArray(geojson)
    ? geojson
    : geojson && Array.isArray(geojson.features)
      ? geojson.features
      : []

  const out = []
  for (let i = 0; i < features.length; i++) {
    const f = features[i]
    if (!f) continue
    const properties = f.properties || {}
    let sourceName = ''
    for (const key of order || []) {
      if (properties[key]) {
        sourceName = properties[key]
        break
      }
    }
    if (!sourceName) {
      sourceName = String(properties && (properties.GEONAME || properties.geoname || properties.NAME || '')).trim()
    }
    if (!sourceName) continue
    const country = normalizeCountryName(sourceName)
    const rings = convertGeometry(country, sourceName, f.geometry)
    if (rings.length === 0) continue
    out.push({
      id: featureId(properties, i),
      country,
      sourceName,
      rings
    })
  }
  return out
}

module.exports = { convertFeatureCollection, splitAntimeridian, closeRing, ringToArrays, NAME_KEYS }