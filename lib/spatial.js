'use strict'

/*
 * Minimal dependency-free spatial grid index.
 *
 * Rings (of territorial sea polygons) are inserted into every 1x1 degree cell
 * their bounding box overlaps. Queries collect candidate ids from the cells a
 * given bounding box spans and return unique candidate ids. This is the
 * "bounding box search" used to quickly find the handful of boundary rings
 * that can possibly contain (or lie close to) a position.
 */

const DEFAULT_CELL = 1 // degrees

class GridIndex {
  constructor(cell = DEFAULT_CELL) {
    this.cell = cell
    this.cells = new Map() // "latIdx,lonIdx" -> number[] (ring ids)
    this.count = 0
  }

  _cell(lat, lon) {
    // cells span [latIdx*cell, (latIdx+1)*cell); same for lon. Handle the
    // antimeridian by normalising lon to [-180, 180).
    let l = lon
    if (l < -180) l += 360
    if (l > 180) l -= 360
    const latIdx = Math.floor((Math.min(90, Math.max(-90, lat)) + 90) / this.cell)
    let lonIdx = Math.floor((l + 180) / this.cell)
    if (lonIdx >= 360 / this.cell) lonIdx = (360 / this.cell) - 1
    if (lonIdx < 0) lonIdx = 0
    return `${latIdx},${lonIdx}`
  }

  _key(latIdx, lonIdx) {
    return `${latIdx},${lonIdx}`
  }

  insert(ringId, minLat, minLon, maxLat, maxLon) {
    const lat0 = Math.floor((Math.min(90, Math.max(-90, minLat)) + 90) / this.cell)
    const lat1 = Math.floor((Math.min(90, Math.max(-90, maxLat)) + 90) / this.cell)
    // Lon can numerically wrap; an inserted ring should already have been
    // normalised so that no edge spans >180 degrees (see features.js) and its
    // bbox fits within [-180,180]. Guard by clamping.
    const clamp = (x) => Math.min(360 / this.cell - 1, Math.max(0, Math.floor(x)))
    const lon0 = clamp(Math.floor((minLon + 180) / this.cell))
    const lon1 = clamp(Math.floor((maxLon + 180) / this.cell))

    for (let i = lat0; i <= lat1; i++) {
      for (let j = lon0; j <= lon1; j++) {
        const key = this._key(i, j)
        let bucket = this.cells.get(key)
        if (!bucket) {
          bucket = []
          this.cells.set(key, bucket)
        }
        bucket.push(ringId)
      }
    }
    this.count++
  }

  // Return the set of ring ids whose cell coverage intersects the query bbox.
  query(minLat, minLon, maxLat, maxLon) {
    const lat0 = Math.floor((Math.min(90, Math.max(-90, minLat)) + 90) / this.cell)
    const lat1 = Math.floor((Math.min(90, Math.max(-90, maxLat)) + 90) / this.cell)
    const clamp = (x) => Math.min(360 / this.cell - 1, Math.max(0, Math.floor(x)))
    const lon0 = clamp(Math.floor((minLon + 180) / this.cell))
    const lon1 = clamp(Math.floor((maxLon + 180) / this.cell))

    const result = new Set()
    for (let i = lat0; i <= lat1; i++) {
      for (let j = lon0; j <= lon1; j++) {
        const bucket = this.cells.get(this._key(i, j))
        if (bucket) {
          for (const id of bucket) {
            result.add(id)
          }
        }
      }
    }
    return result
  }
}

module.exports = { GridIndex, DEFAULT_CELL }