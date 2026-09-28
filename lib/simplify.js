'use strict'

/*
 * Generalises a ring (open representation: no duplicate closing point) of
 * parallel lons/lats arrays using the Douglas-Peucker algorithm. The ring's
 * implicit closing edge (last point back to first) is included in the
 * tolerance test, so the simplified ring is a faithful polygon, not a line.
 *
 * Used by tools/build-resources.js to turn the full-resolution maritime
 * layers into the lightweight, display-only per-country regions served over
 * Signal K's resources API.
 */

const DEG2RAD = Math.PI / 180

// Perpendicular squared distance from point p to the segment a-b, on a
// lon-scaled plane (lon deltas corrected by cos(lat) so the tolerance is
// roughly isotropic in degrees).
function segDistSq(px, py, ax, ay, bx, by, scale) {
  const dx = (bx - ax) * scale
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) {
    const qx = (px - ax) * scale
    const qy = py - ay
    return qx * qx + qy * qy
  }
  let t = (((px - ax) * scale) * dx + (py - ay) * dy) / lenSq
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const rx = (px - ax - t * (bx - ax)) * scale
  const ry = py - ay - t * (by - ay)
  return rx * rx + ry * ry
}

// Returns a new { lons, lats } pair with at most toleranceDeg of error. The
// result ring keeps at least 4 points (a triangle); if the source ring is too
// small to simplify it is returned unchanged.
function simplifyRing(lons, lats, toleranceDeg) {
  const n = lons.length
  if (n <= 4) return { lons, lats }
  const tolSq = toleranceDeg * toleranceDeg

  // Virtual chain of n+1 points; index n aliases point 0 and closes the ring.
  const keep = new Uint8Array(n + 1)
  keep[0] = 1
  keep[n] = 1
  const stack = [[0, n]]
  while (stack.length) {
    const [a, b] = stack.pop()
    const scale = Math.max(
      Math.cos(((lats[a % n] + lats[b % n]) / 2) * DEG2RAD),
      1e-6
    )
    let maxDistSq = tolSq
    let maxIdx = -1
    for (let i = a + 1; i < b; i++) {
      const distSq = segDistSq(
        lons[i % n],
        lats[i % n],
        lons[a % n],
        lats[a % n],
        lons[b % n],
        lats[b % n],
        scale
      )
      if (distSq > maxDistSq) {
        maxDistSq = distSq
        maxIdx = i
      }
    }
    if (maxIdx !== -1) {
      keep[maxIdx] = 1
      if (maxIdx - a > 1) stack.push([a, maxIdx])
      if (b - maxIdx > 1) stack.push([maxIdx, b])
    }
  }

  const outLons = []
  const outLats = []
  for (let i = 0; i < n; i++) {
    if (keep[i]) {
      outLons.push(lons[i])
      outLats.push(lats[i])
    }
  }
  if (outLons.length < 3) return { lons, lats }
  return { lons: outLons, lats: outLats }
}

module.exports = { simplifyRing }