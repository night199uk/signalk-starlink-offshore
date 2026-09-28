# SignalK Starlink Offshore

A SignalK plugin that tracks the vessel against the world **territorial sea
(12 nautical mile)** boundaries and reports the **maritime zone** the vessel
is in: territorial sea, internal waters, land, or high seas - with the
sovereign country for each. It forecasts the next change of the countries
whose jurisdiction the vessel is under (enter / leave / transition) based on
course and speed, and raises a notification shortly before a crossing.

## How it works

- The vessel position is taken from `navigation.position`, the course from
  `navigation.courseOverGroundTrue` (with fallbacks to the magnetic variant,
  heading, and `speedThroughWater`), and the speed from
  `navigation.speedOverGround`.
- **The plugin is fully offline**: it ships with pre-converted copies of three
  whole-world datasets in `lib/geodata/` and never touches the network:
  - **territorial sea** — Marine Regions (VLIZ) Territorial Seas (12NM), v4
    (`territorial-seas-world.json.gz`, doi:10.14284/633, CC-BY 4.0)
  - **internal waters** — Marine Regions (VLIZ) World Internal Waters, v4
    (`internal-waters-world.json.gz`, doi:10.14284/631, CC-BY 4.0)
  - **land** — Natural Earth 10m Admin 0 Countries (`land-world.json.gz`,
    public domain)
  Boundary lookups therefore work with no internet connection at all -
  including in open ocean where Starlink is unavailable.
- The three layers resolve to one zone with precedence
  **territorial sea > internal waters > land > high seas**. Because VLIZ
  models the territorial sea strictly seaward of straight baselines, a vessel
  in a bay inside those baselines (e.g. Cartagena harbour) is reported as
  *internal waters* of its country, not as outside any territorial sea.
- A heading is projected along a great circle in small steps; crossings of the
  boundary polygons are detected and their distance refined by bisection, so
  the forecast respects the curve of the Earth.
- Registers as a read-only Signal K *resource provider* for the standard
  `regions` type, serving one generalised region per country with its full
  maritime footprint (territorial sea + internal waters + land) so clients
  such as Freeboard-SK draw the world's offshore boundaries with no
  configuration — see [Signal K resources](#signal-k-resources).

## Published paths

All values are published for `vessels.<self>` under the plugin source
`starlinkOffshore`:

| Path | Type | Meaning |
| --- | --- | --- |
| `navigation.maritimeZone` | string | `territorial-sea` / `internal-waters` / `land` / `high-seas` |
| `navigation.insideTerritorialSea` | boolean | True when inside a country's territorial sea or internal waters |
| `navigation.onLand` | boolean | True when the position is on a landmass |
| `navigation.currentTerritorialSea` | string | Countries currently inside (any zone: territorial sea, internal waters, or land; `''` in high seas) |
| `navigation.nextTerritorialSea` | string | The next country not already inside that will be entered ('' if none) |
| `navigation.timeToNextTerritorialSea` | s | Seconds until entering the next new country |
| `navigation.distanceToNextTerritorialSea` | m | Distance until entering the next new country |
| `navigation.nextEvent` | string | Next jurisdiction change: `enter` / `leave` / `transition` / `none` |
| `navigation.nextEventDistanceM` | m | Distance to the next event of any kind |
| `navigation.timeToLeaveTerritorialSea` | s | Seconds until leaving the current jurisdiction (territorial sea, internal waters, or land) |
| `navigation.distanceToLeaveTerritorialSea` | m | Distance until leaving the current jurisdiction |
| `navigation.territorialSeaBoundaryDistanceM` | m | Distance to the nearest jurisdiction boundary (territorial sea, internal waters, or land) |

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
(12 nm), internal waters and land — so map clients such as Freeboard-SK render
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
  `lib/geodata/country-regions.json.gz`. Only countries with a boundary in the
  maritime layers (territorial sea or internal waters) produce a region.

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

No runtime dependencies. Node >= 20 (uses global `fetch`).

```sh
npm test                 # run the unit tests
node bin/estimate.js --lat 50 --lon -4 --cog 235 --speed-kn 6.5
```

`bin/estimate.js` loads the bundled world datasets and prints the maritime
zone and crossing forecast, without needing a running SignalK server.

### Updating the bundled world datasets

The bundled datasets were produced from the official downloads (shapefile
variants) with:

```sh
npm install          # dev dependency: `shapefile`
node tools/convert-world.js --shp <directory>/eez_12nm_v4.shp \
  --out lib/geodata/territorial-seas-world.json.gz
node tools/convert-world.js --shp <directory>/eez_internal_waters_v4.shp \
  --out lib/geodata/internal-waters-world.json.gz
node tools/convert-world.js --shp <directory>/ne_10m_admin_0_countries.shp \
  --out lib/geodata/land-world.json.gz
```

Then regenerate the display-only per-country regions used by the `regions`
resource provider from the freshly converted layers:

```sh
node tools/build-resources.js
```

Sources: VLIZ `World_12NM_v4_20231025.zip` and
`World_Internal_Waters_v4_20231025.zip` from
https://www.marineregions.org/downloads.php; Natural Earth 10m Admin 0
Countries from
https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-admin-0-countries/.

Re-run these whenever a new dataset version is released, then commit the
updated `lib/geodata/*.json.gz` files (including
`country-regions.json.gz`).

## Data attribution and disclaimer

- Territorial seas: VLIZ Maritime Boundaries Geodatabase: Territorial Seas
  (12NM), version 4 - Flanders Marine Institute (2023),
  https://doi.org/10.14284/633, licensed CC-BY 4.0.
- Internal waters: VLIZ World Internal Waters, version 4 - Flanders Marine
  Institute (2023), https://doi.org/10.14284/631, licensed CC-BY 4.0.
- Land: Natural Earth 10m Admin 0 Countries, public domain.

See `NOTICE` and `geodata/LICENSE_*.txt` for the full licenses and terms of
use.

Marine Regions states that its data "is not meant to be used for ... legal,
economical ... or navigational purposes" and has "no legal value".
The maritime zone and country status reported by this plugin is
**informative only** and must not be relied upon for the safety or legality
of a voyage.