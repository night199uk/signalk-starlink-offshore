# SignalK Starlink Offshore

**Know when to switch Starlink Ocean mode on or off.**

Starlink separates offshore service from service in a country's coastal waters.
Starlink Offshore tells you which side of that line you are on - live, and ahead
of time - so you can enable Ocean mode when you need it and turn it off when you
don't.

It uses the same maritime definitions Starlink applies: territorial seas,
internal waters and archipelagic waters decide offshore versus onshore, and the
coast layer identifies land. Everything runs offline from bundled worldwide
data, so it works exactly when your Starlink connection is the thing you are
trying to manage.

## Why use it

- Stop paying for Ocean mode while you are still in coastal waters.
- Switch before you leave coverage, not after.
- See the country whose waters you are in - and the next one you are heading for.
- Get a warning with distance and ETA before each boundary, so switching is
  never a surprise.
- Works with no internet connection.

## What you see

All values are published for `vessels.<self>` from the `starlinkOffshore`
source:

| Value | Meaning |
| --- | --- |
| `navigation.maritimeZone` | `territorial-sea`, `land` (coast) or `high-seas` |
| `navigation.insideTerritorialSea` | Inside a country's 12 NM territorial sea |
| `navigation.onLand` | On the coast: land, internal waters or archipelagic waters |
| `navigation.currentTerritorialSea` | Countries you are currently in |
| `navigation.nextTerritorialSea` | The next new country you will enter |
| `navigation.timeToNextTerritorialSea` / `distanceToNextTerritorialSea` | ETA and distance to that entry |
| `navigation.nextEvent` | Next change: `enter`, `leave`, `transition` or `none` |
| `navigation.nextEventDistanceM` | Metres to the next jurisdiction change |
| `navigation.timeToLeaveTerritorialSea` / `distanceToLeaveTerritorialSea` | When you will leave your current waters |
| `navigation.territorialSeaBoundaryDistanceM` | Metres to the nearest boundary |

`high-seas` is the usual cue that Ocean mode is needed.

## Notifications

- `notifications.starlinkOffshore.territorialSea` - warns shortly before a
  boundary crossing (default 2 NM), naming the country and giving an ETA.
  Otherwise carries a normal status message.
- `notifications.starlinkOffshore.dataStatus` - confirms the bundled boundary
  data is loaded.

## Installing

Install **Starlink Offshore** from the Signal K App Store and enable it, or:

```sh
npm install signalk-starlink-offshore
```

Then restart the Signal K server. There is no setup: it starts reporting as soon
as a position is available.

## Configuration

| Key | Default | Description |
| --- | --- | --- |
| `lookaheadNm` | `250` | How far ahead to forecast crossings, in nautical miles |
| `warningDistanceNm` | `2` | How far before a crossing to raise the warning |
| `computeIntervalSeconds` | `2` | How often the outputs are recalculated |
| `courseSource` | `cog` | Use course over ground (`cog`) or vessel `heading` |

## How it works

Starlink Offshore compares your position with worldwide maritime boundaries:
territorial seas (12 NM from the baselines), internal waters, archipelagic
waters and land. It projects your current course and speed ahead, forecasts the
next change of jurisdiction, and warns you before it happens.

The boundary data is pre-converted and bundled with the plugin, so there are no
lookups over the internet and no dependence on Starlink or any other connection.

## Data attribution

Boundary data is derived from the Marine Regions (VLIZ) Maritime Boundaries
Geodatabase, licensed CC-BY 4.0. See `NOTICE` for sources and terms.

The reported zone is **informational only**: it must not be used for navigation
or as legal advice. Confirm service eligibility and plan requirements with
Starlink.

## Development

```sh
npm test
node bin/estimate.js --lat 50 --lon -4 --cog 235 --speed-kn 6.5
```

`bin/estimate.js` prints the current zone and crossing forecast without a running
server. Boundary data sources, licenses and rebuild instructions are in
[DATASETS.md](DATASETS.md).
