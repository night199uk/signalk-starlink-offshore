'use strict'

/*
 * Zones aggregates the independent boundary sets the plugin ships with and
 * answers "which maritime zone is the vessel in?".
 *
 * Precedence:  territorial sea > internal waters > land > high seas.
 *   - territorial sea: Marine Regions (VLIZ) Territorial Seas 12NM v4 (doi:10.14284/633)
 *   - internal waters: Marine Regions (VLIZ) World Internal Waters v4 (doi:10.14284/631)
 *   - land:            Natural Earth 10m admin-0 countries (public domain)
 *
 * Note territorial seas and internal waters are disjoint: VLIZ models the
 * territorial sea as strictly seaward of the straight baselines, so a bay
 * inside those baselines (e.g. Cartagena harbour) is internal waters, not
 * territorial sea. The datasets are authoritative enough to distinguish, which
 * is the point of reporting a zone rather than just "inside/outside TS".
 */

class Zones {
  constructor(options = {}) {
    this.territorialSea = options.territorialSea || null
    this.internalWaters = options.internalWaters || null
    this.land = options.land || null
  }

  // Returns { zone, countries } where zone is one of
  // 'territorial-sea' | 'internal-waters' | 'land' | 'high-seas'.
  zoneAt(lat, lon) {
    for (const [zone, boundaries] of [
      ['territorial-sea', this.territorialSea],
      ['internal-waters', this.internalWaters],
      ['land', this.land]
    ]) {
      if (boundaries && boundaries.features.length > 0) {
        const countries = boundaries.countriesAt(lat, lon)
        if (countries.length > 0) return { zone, countries }
      }
    }
    return { zone: 'high-seas', countries: [] }
  }

  // Feature counts per loaded layer, for status/reporting.
  layerCounts() {
    return {
      territorialSea: this.territorialSea ? this.territorialSea.features.length : 0,
      internalWaters: this.internalWaters ? this.internalWaters.features.length : 0,
      land: this.land ? this.land.features.length : 0
    }
  }

  // Distance in nautical miles from the point to the nearest edge of any
  // loaded layer (territorial sea, internal waters or land), or null when
  // no layer is loaded. In internal waters this is the nearest internal
  // waters edge (e.g. the baseline), not the seaward territorial sea edge.
  nearestBoundaryNm(lat, lon, maxRadiusNm) {
    let best = null
    for (const boundaries of [this.territorialSea, this.internalWaters, this.land]) {
      if (!boundaries || boundaries.features.length === 0) continue
      const d = boundaries.nearestBoundaryNm(lat, lon, maxRadiusNm)
      if (d != null && (best === null || d < best)) best = d
    }
    return best
  }
}

module.exports = { Zones }