'use strict'

/*
 * Read-only Signal K resource provider. Registers the plugin as a provider
 * for the standard 'regions' resource type: one generalised region per
 * country covering its territorial sea (12 NM) and coast (land, internal and
 * archipelagic waters), generated from the bundled world datasets by
 * tools/build-resources.js.
 *
 * The provider implements the ResourceProvider interface expected by Signal
 * K's resource API (/signalk/v2/api/resources): listResources and getResource
 * are supported; setResource/deleteResource reject with 'Not implemented'
 * because the dataset is read-only. Clients such as Freeboard-SK render the
 * regions in their built-in "Regions" layer with no configuration.
 */

const fs = require('fs')
const zlib = require('zlib')

const RESOURCES_FORMAT = 1

function loadRegions(file, logger = { error() {} }) {
  if (!file || !fs.existsSync(file)) {
    logger.error(`Bundled regions resource file not found: ${file}`)
    return []
  }
  let raw
  try {
    raw = zlib.gunzipSync(fs.readFileSync(file))
  } catch (err) {
    logger.error(`Could not read bundled regions resource file: ${err.message}`)
    return []
  }
  try {
    const data = JSON.parse(raw.toString('utf8'))
    if (data.format === RESOURCES_FORMAT && Array.isArray(data.regions)) {
      return data.regions
    }
    logger.error('Bundled regions resource file has an unexpected format')
  } catch (err) {
    logger.error(`Bundled regions resource file invalid: ${err.message}`)
  }
  return []
}

// Query bboxes arrive as 'west,south,east,north' (comma string or array).
function parseBbox(value) {
  if (value == null) return null
  const parts = (Array.isArray(value) ? value : String(value).split(',')).map(Number)
  if (parts.length < 4 || parts.some((p) => !Number.isFinite(p))) return null
  const [west, south, east, north] = parts
  return {
    west: Math.min(west, east),
    south: Math.min(south, north),
    east: Math.max(west, east),
    north: Math.max(south, north)
  }
}

function toBox(b) {
  if (Array.isArray(b)) {
    const [west, south, east, north] = b
    return { west, south, east, north }
  }
  return b
}

function intersects(a, b) {
  const r = toBox(b)
  return !(r.west > a.east || r.east < a.west || r.south > a.north || r.north < a.south)
}

// Build a ResourceProvider-registry-compatible object. The registry (see
// signalk-server src/api/resources/index.ts) validates the provider via
// isResourceProvider(), which requires the callable methods to live under a
// 'methods' property; anything else is rejected with 'Error missing
// ResourceProvider.methods!'.
function createRegionsProvider({ file, logger } = {}) {
  const regions = loadRegions(file, logger)
  const byId = new Map(regions.map((entry) => [entry.id, entry.resource]))
  return {
    type: 'regions',
    count: regions.length,
    methods: {
      listResources(query = {}) {
        const bbox = parseBbox(query.bbox)
        const out = {}
        for (const entry of regions) {
          if (!bbox || (entry.bbox && intersects(bbox, entry.bbox))) {
            out[entry.id] = entry.resource
          }
        }
        return Promise.resolve(out)
      },
      getResource(id, property) {
        const resource = byId.get(id)
        if (!resource) return Promise.reject(new Error(`Region not found: ${id}`))
        if (property != null) return Promise.resolve(resource[property])
        return Promise.resolve(resource)
      },
      setResource() {
        return Promise.reject(new Error('Not implemented: the regions dataset is read-only'))
      },
      deleteResource() {
        return Promise.reject(new Error('Not implemented: the regions dataset is read-only'))
      }
    }
  }
}

module.exports = { createRegionsProvider, loadRegions }