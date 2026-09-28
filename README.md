# SignalK Starlink Offshore

A SignalK plugin that tracks the vessel against the world **territorial sea
(12 nautical mile)** boundary and the **coast** (land, internal and
archipelagic waters). It reports the **maritime zone** the vessel is in:
territorial sea, coast, or high seas - with the sovereign country - forecasts
the next change of the countries whose jurisdiction the vessel is under
(enter / leave / transition) based on course and speed, and raises a
notification shortly before a crossing.

## How it works

- The vessel position is taken from `navigation.position`, the course from
  `navigation.courseOverGroundTrue` (with fallbacks to the magnetic variant,
  heading, and `speedThroughWater`), and the speed from
  `navigation.speedOverGround`.
- **The plugin is fully offline**: it ships with pre-converted copies of two
  whole-world datasets in `lib/geodata/` and never touches the network:
  - **territorial sea** — Marine Regions (VLIZ) Territorial Seas (12NM), v4
    (`territorial-seas-world.json.gz`, doi:10.14284/633, CC-BY 4.0)
  - **coast** — Marine Regions (VLIZ) land + internal waters + archipelagic
    waters, dissolved into one polygon set per country (`coast-world.json.gz`,
    CC-BY 4.0)
  Boundary lookups therefore work with no internet connection at all -
  including in open ocean where Starlink is unavailable.
- The two layers resolve to one zone with precedence
  **territorial sea > coast > high seas**. The coast is everything landward of
  the baselines the territorial sea is measured from, so a bay inside a
  state's straight baselines (e.g. Cartagena harbour) is *coast*, not
  territorial sea, and `navigation.onLand` is true there.
- Both layers come from the Marine Regions (VLIZ) Maritime Boundaries
  Geodatabase and share the same baselines, and the coast's constituents (land,
  internal waters, archipelagic waters) are dissolved rather than kept as
  separate layers - so a position never falls into a sliver between them.
- A heading is projected along a great circle in small steps; crossings of the
  boundary polygons are detected and their distance refined by bisection, so
  the forecast respects the curve of the Earth.
- Registers as a read-only Signal K *resource provider* for the standard
  `regions` type, serving one generalised region per country with its full
  maritime footprint (territorial sea + coast) so clients
  such as Freeboard-SK draw the world's offshore boundaries with no
  configuration — see [Signal K resources](#signal-k-resources).

## Published paths

All values are published for `vessels.<self>` under the plugin source
`starlinkOffshore`:

| Path | Type | Meaning |
| --- | --- | --- |
| `navigation.maritimeZone` | string | `territorial-sea` / `land` / `high-seas` |
| `navigation.insideTerritorialSea` | boolean | True when inside the 12 NM territorial sea |
| `navigation.onLand` | boolean | True on the coast (land, internal or archipelagic waters) |
| `navigation.currentTerritorialSea` | string | Countries currently inside (either zone; `''` in high seas) |
| `navigation.nextTerritorialSea` | string | The next country not already inside that will be entered ('' if none) |
| `navigation.timeToNextTerritorialSea` | s | Seconds until entering the next new country |
| `navigation.distanceToNextTerritorialSea` | m | Distance until entering the next new country |
| `navigation.nextEvent` | string | Next jurisdiction change: `enter` / `leave` / `transition` / `none` |
| `navigation.nextEventDistanceM` | m | Distance to the next event of any kind |
| `navigation.timeToLeaveTerritorialSea` | s | Seconds until leaving the current jurisdiction (territorial sea or coast) |
| `navigation.distanceToLeaveTerritorialSea` | m | Distance until leaving the current jurisdiction |
| `navigation.territorialSeaBoundaryDistanceM` | m | Distance to the nearest jurisdiction boundary (either layer) |

## Notifications

- `notifications.starlinkOffshore.territorialSea` — warns (`visual` + `sound`)
  when the next crossing is within `warningDistanceNm` (default 2 nm), stating
  the country and an ETA. Otherwise carries a normal status message.
- `notifications.starlinkOffshore.dataStatus` — `normal` when the bundled
  boundary data is loaded, `alarm` when it is unavailable.

## Signal K resources

The plugin registers as a read-only Signal K **resource provider** for the
standard `regions` resource type, served at
`/signalk/v2/api/resources/regions`. It provides one region per country
covering that country's full **maritime footprint** — its territorial sea
(12 nm) and coast — so map clients such as Freeboard-SK render
the world's offshore boundaries in their built-in "Regions" layer without any
configuration.

- **Read-only**: `listResources` (with `bbox`, `distance` and `zoom`
  parameters respected where sensible) and `getResource` are implemented;
  `setResource`/`deleteResource` reject with `Not implemented`.
- **Simplified for display**: the polygons are generalised (Douglas-Peucker,
  adaptively finer for small entities such as Monaco) with tiny fragments
  dropped, and flagged `informativeOnly` in their GeoJSON properties. They
  provide map context, never navigational value.
- Built from the same bundled datasets by `tools/build-resources.js` into
  `lib/geodata/country-regions.json.gz`. Only countries with a territorial sea
  produce a region.

## Configuration

All datasets are bundled with the plugin and always used; the plugin makes
no network requests. The only configurable options are:

| Key | Default | Description |
| --- | --- | --- |
| `lookaheadNm` | `250` | Forecast horizon in nautical miles |
| `warningDistanceNm` | `2` | Notification warning distance in nautical miles |
| `computeIntervalSeconds` | `2` | How often the outputs are recomputed |
| `courseSource` | `cog` | Course source: `cog` or `heading` |

## Development

No runtime dependencies. Node >= 20 (the build tools use global `fetch`).

```sh
npm test                 # run the unit tests
node bin/estimate.js --lat 50 --lon -4 --cog 235 --speed-kn 6.5
```

`bin/estimate.js` loads the bundled world datasets and prints the maritime
zone and crossing forecast, without needing a running SignalK server.

### Updating the bundled world datasets

The bundled datasets are built from the official VLIZ downloads. Converted
source caches are kept in `geodata/` (gitignored, not shipped); only the final
`lib/geodata/*.json.gz` files ship.

```sh
npm install          # dev dependencies: shapefile, polygon-clipping

# territorial sea (shipped)
node tools/convert-world.js --shp <dir>/eez_12nm_v4.shp \
  --out lib/geodata/territorial-seas-world.json.gz

# coast sources: VLIZ land (World Countries 2014), internal waters,
# archipelagic waters
node tools/fetch-vliz-wfs.js --layer worldcountries_esri_2014 \
  --out geodata/vliz-land-esri-2014.geojson \
  --fix "Mauritius=Republic of Mauritius,Western Sahara=Morocco"
node tools/convert-world.js --geojson geodata/vliz-land-esri-2014.geojson \
  --out geodata/land-world.json.gz
node tools/convert-world.js --shp <dir>/eez_internal_waters_v4.shp \
  --out geodata/internal-waters-world.json.gz
node tools/fetch-vliz-wfs.js --layer eez_archipelagic_waters \
  --out geodata/vliz-archipelagic-waters.geojson
node tools/convert-world.js --geojson geodata/vliz-archipelagic-waters.geojson \
  --out geodata/archipelagic-waters-world.json.gz

# dissolve the coast sources into one polygon set per country (shipped)
node tools/build-coast.js

# regenerate the display-only per-country regions (shipped)
node tools/build-resources.js
```

Sources: VLIZ `World_12NM_v4_20231025.zip` and
`World_Internal_Waters_v4_20231025.zip` from
https://www.marineregions.org/downloads.php; World Countries 2014 land and
archipelagic waters from the VLIZ WFS (https://geo.vliz.be/geoserver). All
CC-BY 4.0.

Re-run these whenever a new dataset version is released, then commit the
updated `lib/geodata/*.json.gz` files.

## Data attribution and disclaimer

- Territorial seas: VLIZ Maritime Boundaries Geodatabase: Territorial Seas
  (12NM), version 4 - Flanders Marine Institute (2023),
  https://doi.org/10.14284/633, licensed CC-BY 4.0.
- Coast, from the VLIZ Maritime Boundaries Geodatabase (all CC-BY 4.0):
  World Internal Waters v4 (https://doi.org/10.14284/631), Archipelagic Waters
  v4 (https://doi.org/10.14284/629), and World Countries 2014 land (the normal
  baseline), all dissolved into one polygon set per country.

See `NOTICE` and `geodata/LICENSE_*.txt` for the full licenses and terms of
use.

Marine Regions states that its data "is not meant to be used for ... legal,
economical ... or navigational purposes" and has "no legal value".
The maritime zone and country status reported by this plugin is
**informative only** and must not be relied upon for the safety or legality
of a voyage.