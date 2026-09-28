'use strict'

/*
 * Loads the bundled, whole-world maritime boundary datasets the plugin ships
 * with. Each dataset is a gzip-compressed JSON file (CACHE_FORMAT) of
 * internal features produced by tools/convert-world.js from the official
 * VLIZ / Natural Earth downloads. There is no network access: every lookup
 * runs against these packaged files, so the plugin works fully offline.
 *
 * The three datasets:
 *   - territorial sea: Marine Regions (VLIZ) Territorial Seas 12NM v4
 *     (doi:10.14284/633)
 *   - internal waters: Marine Regions (VLIZ) World Internal Waters v4
 *     (doi:10.14284/631)
 *   - land:            Natural Earth 10m admin-0 countries (public domain)
 */

const fs = require('fs')
const zlib = require('zlib')

const CACHE_FORMAT = 1

class TerritoryStore {
  constructor(opts = {}) {
    this.bundledFile = opts.bundledFile || ''
    this.zoneLabel = opts.zoneLabel || 'territorial sea'
    this._logger = opts.logger || { debug() {}, info() {}, warn() {}, error() {} }

    this.features = [] // internal (converted) features
    this.bundledLoaded = false
  }

  // Load the bundled, whole-world dataset (a gzip file in CACHE_FORMAT).
  // Provides complete world coverage with no network access. Returns the
  // number of features loaded, or 0 (e.g. when the file is absent).
  loadBundled() {
    if (!this.bundledFile) return 0
    if (!fs.existsSync(this.bundledFile)) {
      this._logger.error(`Bundled ${this.zoneLabel} dataset not found: ${this.bundledFile}`)
      return 0
    }
    let raw
    try {
      raw = zlib.gunzipSync(fs.readFileSync(this.bundledFile))
    } catch (err) {
      this._logger.error(`Could not read bundled ${this.zoneLabel} dataset: ${err.message}`)
      return 0
    }
    try {
      const data = JSON.parse(raw.toString('utf8'))
      if (data.format === CACHE_FORMAT && Array.isArray(data.features)) {
        this.features = data.features
        this.bundledLoaded = true
        this._logger.info(
          `Loaded ${this.features.length} ${this.zoneLabel} feature(s) from the bundled world dataset`
        )
        return this.features.length
      }
      this._logger.error(`Bundled ${this.zoneLabel} dataset has an unexpected format`)
    } catch (err) {
      this._logger.error(`Bundled ${this.zoneLabel} dataset invalid: ${err.message}`)
    }
    return 0
  }

  toBoundaries() {
    const { Boundaries } = require('./boundaries')
    const b = new Boundaries()
    b.addFeatures(this.features)
    return b
  }
}

module.exports = { TerritoryStore }