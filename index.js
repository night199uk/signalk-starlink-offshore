'use strict'

/*
 * SignalK Starlink Offshore
 *
 * Tracks the vessel position against two world boundary layers (territorial
 * sea 12NM, and the "coast": land + internal waters + archipelagic waters),
 * reports the maritime zone the vessel is in (territorial sea / land / high
 * seas) with the sovereign country/ies, forecasts the next changes of that
 * jurisdiction set (enter / leave / transition) on the current course and
 * speed, and raises a Signal K notification shortly before a crossing.
 *
 * The plugin is fully offline: it ships with two bundled whole-world datasets
 * and never touches the network:
 *   - territorial sea: Marine Regions (VLIZ) Territorial Seas 12NM v4
 *   - coast:          Marine Regions (VLIZ) land + internal waters +
 *                     archipelagic waters, dissolved per country
 *
 * Published paths (vessels.self):
 *   navigation.insideTerritorialSea            boolean (inside the 12 NM territorial sea)
 *   navigation.onLand                          boolean (on land or in internal/archipelagic waters)
 *   navigation.maritimeZone                    'territorial-sea'|'land'|'high-seas'
 *   navigation.currentTerritorialSea           countries inside (any zone; '' in high seas)
 *   navigation.nextTerritorialSea              next NEW country to enter (skips countries already inside; '')
 *   navigation.timeToNextTerritorialSea        seconds until the next entry
 *   navigation.distanceToNextTerritorialSea    metres to the next entry
 *   navigation.nextEvent                       'enter' | 'leave' | 'transition' | 'none'
 *   navigation.nextEventDistanceM              metres to the next event
 *   navigation.timeToLeaveTerritorialSea       seconds until exiting current TS
 *   navigation.distanceToLeaveTerritorialSea   metres to the exit
 *   navigation.territorialSeaBoundaryDistanceM metres to nearest boundary (either layer)
 *
 * Notifications:
 *   notifications.starlinkOffshore.territorialSea   warn shortly before a crossing
 *   notifications.starlinkOffshore.dataStatus       boundary data availability
 *
 * Resources:
 *   Registers as a read-only Signal K resource provider for the standard
 *   'regions' type (/signalk/v2/api/resources/regions), serving one
 *   generalised region per country covering its full maritime footprint
 *   (territorial sea 12NM + coast). Map clients such as Freeboard-SK render
 *   these in their built-in "Regions" layer.
 */

const path = require('path')
const { TerritoryStore } = require('./lib/data')
const { Zones } = require('./lib/zones')
const { analyzeCourse } = require('./lib/boundaries')
const { schema } = require('./lib/schema')
const { createRegionsProvider } = require('./lib/resources')
const { toRadians, normalizeDeg, METERS_PER_NM } = require('./lib/geo')

const NOTIFY_BOUNDARY = 'notifications.starlinkOffshore.territorialSea'
const NOTIFY_DATA = 'notifications.starlinkOffshore.dataStatus'

// Raw self streams that feed the analysis.
const SELF_PATHS = [
  'navigation.position',
  'navigation.courseOverGroundTrue',
  'navigation.courseOverGroundMagnetic',
  'navigation.magneticVariation',
  'navigation.headingTrue',
  'navigation.headingMagnetic',
  'navigation.speedOverGround',
  'navigation.speedThroughWater'
]

// Subscribe the plugin to raw data for its own vessel. Uses the modern
// SubscriptionManager API (app.subscriptionmanager.subscribe); on old servers
// lacking it, falls back to the legacy app.streambundle.getSelfStream().
// The callback receives Signal K deltas that contain only the subscribed
// paths. Returns an unsubscribe function.
function subscribeSelf(app, onDelta) {
  const cancelAll = []
  if (app.subscriptionmanager && typeof app.subscriptionmanager.subscribe === 'function') {
    const onError = (err) => {
      const message = err && err.message ? err.message : String(err)
      app.debug(`Starlink Offshore subscription error: ${message}`)
    }
    app.subscriptionmanager.subscribe(
      {
        context: 'self',
        subscribe: SELF_PATHS.map((path) => ({ path, format: 'delta', policy: 'instant' }))
      },
      cancelAll,
      onError,
      onDelta
    )
  } else {
    for (const path of SELF_PATHS) {
      try {
        const stream = app.streambundle && app.streambundle.getSelfStream(path)
        if (stream && typeof stream.onValue === 'function') {
          cancelAll.push(
            stream.onValue((value) => {
              onDelta({
                context: 'self',
                updates: [{ $source: 'self', values: [{ path, value }] }]
              })
            })
          )
        }
      } catch (err) {
        app.debug(`Could not subscribe to ${path}: ${err.message}`)
      }
    }
  }
  return () => {
    for (const unsub of cancelAll) {
      try {
        if (typeof unsub === 'function') unsub()
      } catch (err) {
        app.debug(`Error unsubscribing: ${err.message}`)
      }
    }
  }
}

module.exports = function (app) {
  const plugin = {}

  plugin.id = 'starlinkOffshore'
  plugin.name = 'Starlink Offshore'
  plugin.description =
    'Evaluates the vessel position against the world territorial sea (12NM), internal ' +
    'waters and land boundaries; reports the maritime zone and country, forecasts ' +
    'jurisdiction changes (enter/leave/transition) on the current course and speed, ' +
    'and raises notifications shortly before each crossing.'
  plugin.schema = schema

  let boundariesTs = null
  let boundariesCoast = null
  let zones = null
  let config = null
  let state = null
  let timer = null
  let metaSent = false
  let lastOutput = null
  let lastBoundaryNotification = null
  let lastDataNotification = null
  let computing = false
  let dataStatus = 'none' // 'none' | 'fresh'
  let regionsProvider = null
  // Caches keyed on quantised inputs. The crossing forecast and the nearest
  // boundary are the expensive operations and depend only on the vessel's
  // position/course/speed (not wall-clock time), so a moored or steady vessel
  // does almost no work and a moving one only recomputes them when the coarsely
  // quantised inputs change.
  let lastInputKey = null
  let forecastCache = null // { key, analysis }
  let nearestCache = null // { key, nm }

  const unsubscribes = []

  plugin.start = function (pluginConfig) {
    config = Object.assign(
      {
        lookaheadNm: 250,
        warningDistanceNm: 2,
        computeIntervalSeconds: 2,
        courseSource: 'cog'
      },
      pluginConfig || {}
    )

    state = {
      pos: null,
      cogTrueRad: null,
      cogMagRad: null,
      variationRad: null,
      headingTrueRad: null,
      headingMagRad: null,
      sogMps: null,
      stwMps: null
    }

    const geodataDir = path.join(__dirname, 'lib', 'geodata')
    const logger = {
      debug: (m) => app.debug(m),
      info: (m) => app.debug(m),
      warn: (m) => app.error(m),
      error: (m) => app.error(m)
    }

    // Both layers ship with the plugin and are always loaded; the plugin never
    // accesses the network. A missing file degrades gracefully (the zone
    // precedence simply has one less competing layer); the territorial sea
    // layer is what makes the plugin useful at all, so its presence decides the
    // dataStatus alarm. The coast layer is queried as "inside any ring" (see
    // lib/boundaries.js) because its per-country dissolve may leave overlapping
    // rings and its holes (lakes) should read as land.
    const loadLayer = (file, zoneLabel, containment) => {
      const s = new TerritoryStore({ bundledFile: file, zoneLabel, containment, logger })
      s.loadBundled()
      return s.toBoundaries()
    }
    boundariesTs = loadLayer(
      path.join(geodataDir, 'territorial-seas-world.json.gz'),
      'territorial sea'
    )
    boundariesCoast = loadLayer(path.join(geodataDir, 'coast-world.json.gz'), 'coast', 'any')

    zones = new Zones({
      territorialSea: boundariesTs,
      coast: boundariesCoast
    })

    dataStatus = boundariesTs.features.length > 0 ? 'fresh' : 'none'

    // Register the read-only 'regions' resource provider (generalised,
    // display-only per-country maritime footprints built from the same
    // bundled datasets). Servers without the resources API ignore this.
    regionsProvider = null
    if (typeof app.registerResourceProvider === 'function') {
      try {
        const provider = createRegionsProvider({
          file: path.join(geodataDir, 'country-regions.json.gz'),
          logger
        })
        app.registerResourceProvider(provider)
        regionsProvider = provider
        logger.info(
          `Registered ${provider.count} country region(s) as a read-only 'regions' resources provider`
        )
      } catch (err) {
        logger.error(`Could not register the country regions resource provider: ${err.message}`)
      }
    }

    // Subscribe to the raw data streams used for the analysis.
    const applyPath = (path, value) => {
      switch (path) {
        case 'navigation.position':
          if (value && typeof value.latitude === 'number' && typeof value.longitude === 'number') {
            state.pos = { lat: value.latitude, lon: value.longitude }
          }
          break
        case 'navigation.courseOverGroundTrue':
          state.cogTrueRad = toRadians(value)
          break
        case 'navigation.courseOverGroundMagnetic':
          state.cogMagRad = toRadians(value)
          break
        case 'navigation.magneticVariation':
          state.variationRad = toRadians(value)
          break
        case 'navigation.headingTrue':
          state.headingTrueRad = toRadians(value)
          break
        case 'navigation.headingMagnetic':
          state.headingMagRad = toRadians(value)
          break
        case 'navigation.speedOverGround':
          state.sogMps = typeof value === 'number' && isFinite(value) ? value : null
          break
        case 'navigation.speedThroughWater':
          state.stwMps = typeof value === 'number' && isFinite(value) ? value : null
          break
      }
    }

    unsubscribes.push(
      subscribeSelf(app, (delta) => {
        if (!delta || !Array.isArray(delta.updates)) return
        for (const update of delta.updates) {
          if (!update || !Array.isArray(update.values)) continue
          for (const item of update.values) {
            if (item && typeof item.path === 'string') applyPath(item.path, item.value)
          }
        }
      })
    )

    timer = setInterval(() => {
      computeNow()
    }, Math.max(1, config.computeIntervalSeconds) * 1000)
    timer.unref && timer.unref()

    const counts = zones ? zones.layerCounts() : {}
    const resourceNote = regionsProvider ? `, ${regionsProvider.count} country regions` : ''
    app.setPluginStatus(
      `Starlink Offshore started (${counts.territorialSea} territorial sea areas, ` +
        `${counts.coast} coastal areas${resourceNote})`
    )
    return true
  }

  plugin.stop = function () {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    while (unsubscribes.length) {
      const unsub = unsubscribes.pop()
      try {
        if (typeof unsub === 'function') unsub()
      } catch (err) {
        app.debug(`Error unsubscribing: ${err.message}`)
      }
    }
  }

  plugin.statusMessage = function () {
    if (!state || !state.pos) return 'Waiting for position'
    const zone = zones ? zones.zoneAt(state.pos.lat, state.pos.lon) : null
    if (!zone) return 'Boundary data not loaded'
    switch (zone.zone) {
      case 'territorial-sea':
        return `Inside ${zone.countries.join(', ')} territorial sea`
      case 'land':
        return `Inside ${zone.countries.join(', ')} (land or internal waters)`
      default:
        return `Outside any country's waters`
    }
  }

  function sendMeta() {
    if (metaSent) return
    metaSent = true
    const grouped = {
      s: [
        'navigation.timeToNextTerritorialSea',
        'navigation.timeToLeaveTerritorialSea'
      ],
      m: [
        'navigation.distanceToNextTerritorialSea',
        'navigation.distanceToLeaveTerritorialSea',
        'navigation.territorialSeaBoundaryDistanceM',
        'navigation.nextEventDistanceM'
      ]
    }
    for (const [units, paths] of Object.entries(grouped)) {
      app.handleMessage(plugin.id, {
        context: `vessels.${app.selfId}`,
        updates: [
          {
            $source: plugin.id,
            meta: paths.map((p) => ({ path: p, value: { units } }))
          }
        ]
      })
    }
  }

  function currentCourseDeg() {
    let rad = null
    if (config.courseSource === 'heading') {
      rad = state.headingTrueRad
      if (rad == null && state.headingMagRad != null) {
        rad = state.headingMagRad + (state.variationRad || 0)
      }
    } else {
      rad = state.cogTrueRad
      if (rad == null && state.cogMagRad != null) {
        rad = state.cogMagRad + (state.variationRad || 0)
      }
    }
    if (rad == null) return null
    return normalizeDeg(rad * 180 / Math.PI)
  }

  function currentSpeedMps() {
    if (state.sogMps != null) return state.sogMps
    return state.stwMps
  }

  function computeNow() {
    if (!state.pos || !boundariesTs) return
    if (computing) return // defensive: only true during the try block below
    computing = true
    try {
      sendMeta()
      const { lat, lon } = state.pos
      const cogDeg = currentCourseDeg()
      const sogMps = currentSpeedMps()

      // Do nothing unless an input actually changed (quantised to ~1 m / 0.5
      // degrees / 0.1 m/s). Keeps a moored or steady vessel free.
      const q = (v, s) => (v == null || !isFinite(v) ? 'x' : Math.round(v / s))
      const inputKey = `${q(lat, 1e-5)}:${q(lon, 1e-5)}:${q(cogDeg, 0.5)}:${q(sogMps, 0.1)}`
      if (inputKey === lastInputKey) return
      lastInputKey = inputKey

      const zone = zones ? zones.zoneAt(lat, lon) : { zone: 'high-seas', countries: [] }
      // The two booleans a Starlink user cares about: in a country's 12 NM
      // territorial sea, or on its coast (land, internal or archipelagic
      // waters). The precise zone is named by navigation.maritimeZone.
      const inside = zone.zone === 'territorial-sea'

      // Nearest boundary: recompute only when the position moves ~10 m
      // (position key at 1e-4 degrees).
      const posKey = `${q(lat, 1e-4)}:${q(lon, 1e-4)}`
      let nearestNm
      if (nearestCache && nearestCache.key === posKey) {
        nearestNm = nearestCache.nm
      } else {
        nearestNm = zones
          ? zones.nearestBoundaryNm(lat, lon, config.lookaheadNm)
          : boundariesTs.nearestBoundaryNm(lat, lon, config.lookaheadNm)
        nearestCache = { key: posKey, nm: nearestNm }
      }

      // The crossing forecast runs over the *jurisdiction* predicate: the set
      // of countries the position is inside across either layer (territorial
      // sea or coast), combined in zone precedence. An event is a change of
      // that set, so crossing from Colombia's coast into Venezuela's is a
      // 'transition' rather than an enter or leave alone. Recompute only when
      // position (~10 m), course (~1 deg) or speed (~0.5 m/s) change; otherwise
      // reuse the cached forecast (distances/times stay valid).
      const forecastKey = `${posKey}:${q(cogDeg, 1)}:${q(sogMps, 0.5)}`
      let analysis
      if (forecastCache && forecastCache.key === forecastKey) {
        analysis = forecastCache.analysis
      } else {
        const jurisdictionAt = (la, lo) =>
          zones ? zones.zoneAt(la, lo).countries : boundariesTs.countriesAt(la, lo)
        analysis =
          cogDeg != null
            ? analyzeCourse(jurisdictionAt, lat, lon, cogDeg, sogMps, {
                horizonNm: config.lookaheadNm,
                stepNm: 0.5
              })
            : { startCountries: jurisdictionAt(lat, lon), crossings: [] }
        forecastCache = { key: forecastKey, analysis }
      }

      const first = analysis.crossings[0] || null
      // "Next" means the next country the vessel is not already under: skip
      // crossings that only re-enter a country already in the current set
      // (e.g. leaving Cartagena bay and immediately re-entering Colombia's TS).
      const startSet = analysis.startCountries || []
      const entry =
        analysis.crossings.find(
          (c) => c.countriesEntering.some((country) => !startSet.includes(country))
        ) || null
      const leave = analysis.crossings.find((c) => c.type !== 'enter') || null

      const outputs = {
        'navigation.maritimeZone': zone.zone,
        'navigation.insideTerritorialSea': inside,
        'navigation.onLand': zone.zone === 'land',
        'navigation.currentTerritorialSea': zone.countries.length
          ? zone.countries.join(', ')
          : '',
        'navigation.nextTerritorialSea': entry
          ? entry.countriesEntering.join(', ')
          : '',
        'navigation.timeToNextTerritorialSea': entry ? entry.timeSeconds : null,
        'navigation.distanceToNextTerritorialSea': entry
          ? entry.distanceNm * METERS_PER_NM
          : null,
        'navigation.nextEvent': first ? first.type : 'none',
        'navigation.nextEventDistanceM': first ? first.distanceNm * METERS_PER_NM : null,
        'navigation.timeToLeaveTerritorialSea': leave ? leave.timeSeconds : null,
        'navigation.distanceToLeaveTerritorialSea': leave
          ? leave.distanceNm * METERS_PER_NM
          : null,
        'navigation.territorialSeaBoundaryDistanceM':
          nearestNm != null ? nearestNm * METERS_PER_NM : null
      }

      sendOutputs(outputs)
      sendBoundaryNotification({
        zone,
        first,
        entry,
        leave,
        nearestNm,
        crossingCourse: cogDeg != null
      })
      sendDataNotification()
    } catch (err) {
      app.error(`Starlink Offshore: ${err.stack || err.message}`)
    } finally {
      computing = false
    }
  }

  function sendOutputs(outputs) {
    const values = []
    for (const [path, value] of Object.entries(outputs)) {
      let isNew = !lastOutput
      if (!isNew) {
        const prev = lastOutput[path]
        if (Array.isArray(prev) && Array.isArray(value)) {
          isNew =
            prev.length !== value.length || prev.some((c, i) => c !== value[i])
        } else if (prev !== value) {
          isNew = true
        }
      }
      if (isNew) {
        values.push({ path, value, timestamp: new Date().toISOString() })
        if (!lastOutput) lastOutput = {}
        lastOutput[path] = value
      }
    }
    if (values.length === 0) return
    app.handleMessage(plugin.id, {
      context: `vessels.${app.selfId}`,
      updates: [
        {
          $source: plugin.id,
          values
        }
      ]
    })
  }

  function formatEta(seconds) {
    if (seconds == null || !isFinite(seconds)) return null
    if (seconds < 60) return `${Math.round(seconds)}s`
    if (seconds < 3600) {
      const m = Math.floor(seconds / 60)
      const s = Math.round(seconds % 60)
      return `${m}m ${s}s`
    }
    const h = Math.floor(seconds / 3600)
    const m = Math.round((seconds % 3600) / 60)
    return `${h}h ${m}m`
  }

  function boundaryNotificationValue(s) {
    const warnNm = config.warningDistanceNm
    let stateName = 'normal'
    let message

    if (dataStatus === 'none') {
      stateName = 'alarm'
      message = 'Maritime boundary data is unavailable'
    } else if (s.first && s.first.distanceNm <= warnNm) {
      const c = s.first
      const dist = c.distanceNm.toFixed(1)
      const eta = formatEta(c.timeSeconds)
      let what
      if (c.type === 'enter') {
        what = `Entering ${c.countriesEntering.join(', ')} waters`
      } else if (c.type === 'leave') {
        what = `Leaving ${c.countriesLeaving.join(', ')} waters`
      } else {
        what = `Crossing into ${c.countriesEntering.join(', ')} waters`
      }
      // Crossing within the warning distance -> warn.
      stateName = 'warn'
      message = `${what} in ${dist} nm${eta ? ` (≈${eta})` : ''}`
    } else if (s.zone && s.zone.zone === 'territorial-sea') {
      message = `Inside ${s.zone.countries.join(', ')} territorial sea`
      if (s.leave) {
        const dist = s.leave.distanceNm.toFixed(1)
        const eta = formatEta(s.leave.timeSeconds)
        message += ` · leaves ≈${dist} nm${eta ? ` (${eta})` : ''}`
      }
    } else if (s.zone && s.zone.zone === 'land') {
      message = `On the coast of ${s.zone.countries.join(', ')}`
    } else if (s.crossingCourse) {
      if (s.entry) {
        const dist = s.entry.distanceNm.toFixed(1)
        const eta = formatEta(s.entry.timeSeconds)
        message = `Outside any country's waters · next entry: ${s.entry.countriesEntering.join(', ')} in ≈${dist} nm${eta ? ` (${eta})` : ''}`
      } else {
        message = `Outside any country's waters`
      }
    } else {
      message = `Outside any country's waters`
    }

    let method = []
    if (stateName === 'warn') method = ['visual', 'sound']
    else if (stateName === 'alarm') method = ['sound', 'visual']

    return { state: stateName, method, message, timestamp: new Date().toISOString() }
  }

  function sendBoundaryNotification(info) {
    const value = boundaryNotificationValue(info)
    const key = JSON.stringify(value)
    if (key === lastBoundaryNotification) return
    lastBoundaryNotification = key
    app.handleMessage(plugin.id, {
      context: `vessels.${app.selfId}`,
      updates: [
        {
          $source: plugin.id,
          values: [{ path: NOTIFY_BOUNDARY, value }]
        }
      ]
    })
  }

  function sendDataNotification() {
    let value
    if (dataStatus === 'fresh') {
      const layers = zones ? zones.layerCounts() : {}
      const counts = []
      if (layers.territorialSea > 0) {
        counts.push(`${layers.territorialSea} territorial sea ${layers.territorialSea === 1 ? 'area' : 'areas'}`)
      }
      if (layers.coast > 0) {
        counts.push(`${layers.coast} coastal ${layers.coast === 1 ? 'area' : 'areas'}`)
      }
      value = {
        state: 'normal',
        method: [],
        message: counts.length > 0
          ? `Boundary data loaded (${counts.join(', ')})`
          : 'Boundary data loaded'
      }
    } else {
      value = {
        state: 'alarm',
        method: ['sound', 'visual'],
        message: 'Maritime boundary data unavailable'
      }
    }
    const key = JSON.stringify(value)
    if (key === lastDataNotification) return
    lastDataNotification = key
    app.handleMessage(plugin.id, {
      context: `vessels.${app.selfId}`,
      updates: [
        {
          $source: plugin.id,
          values: [{ path: NOTIFY_DATA, value }]
        }
      ]
    })
  }

  return plugin
}