'use strict'

/*
 * Zones aggregates the two boundary sets the plugin ships with and answers
 * "which maritime zone is the vessel in?".
 *
 * Precedence:  territorial sea > coast > high seas.
 *   - territorial sea: Marine Regions (VLIZ) Territorial Seas 12NM v4 (doi:10.14284/633)
 *   - coast:          Marine Regions (VLIZ) land + internal waters + archipelagic
 *                     waters, dissolved per country (see tools/build-coast.js)
 *
 * The two are disjoint by construction (the coast is landward of the baselines
 * the territorial sea is measured from) and tile without gaps. There is no
 * separate land vs internal-waters distinction: both are "coast", reported via
 * navigation.onLand. A bay inside a state's straight baselines (e.g. Cartagena
 * harbour) is therefore coast, not territorial sea.
 */

class Zones {
  constructor(options = {}) {
    this.territorialSea = options.territorialSea || null
    this.coast = options.coast || null
  }

  // Returns { zone, countries } where zone is one of
  // 'territorial-sea' | 'land' | 'high-seas'. ('land' means the coast layer:
  // land or internal/archipelagic waters.)
  zoneAt(lat, lon) {
    for (const [zone, boundaries] of [
      ['territorial-sea', this.territorialSea],
      ['land', this.coast]
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
      coast: this.coast ? this.coast.features.length : 0
    }
  }

  // Distance in nautical miles from the point to the nearest edge of either
  // layer (territorial sea or coast), or null when no layer is loaded.
  nearestBoundaryNm(lat, lon, maxRadiusNm) {
    let best = null
    for (const boundaries of [this.territorialSea, this.coast]) {
      if (!boundaries || boundaries.features.length === 0) continue
      const d = boundaries.nearestBoundaryNm(lat, lon, maxRadiusNm)
      if (d != null && (best === null || d < best)) best = d
    }
    return best
  }
}

module.exports = { Zones }
