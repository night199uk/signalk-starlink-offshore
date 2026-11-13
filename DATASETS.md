# Bundled world datasets

Starlink Offshore ships its boundary data pre-converted, so the plugin never
touches the network at runtime. This document covers what the data is and how to
rebuild it. Most users do not need it.

## What ships

| File | Layer |
| --- | --- |
| `lib/geodata/territorial-seas-world.json.gz` | 12 NM territorial seas |
| `lib/geodata/coast-world.json.gz` | land + internal waters + archipelagic waters, dissolved per country |
| `lib/geodata/country-regions.json.gz` | generalised per-country regions for map clients |

All three are derived from the Marine Regions (VLIZ) Maritime Boundaries
Geodatabase (CC-BY 4.0). See `NOTICE` for the full attribution and
`geodata/LICENSE_*.txt` for the terms.

Converted *source* caches are kept in `geodata/` and are **not** shipped.

## Why the coast layer is dissolved

The territorial sea is the 12 NM belt seaward of a country's baselines. The
coast - everything landward of those baselines - is assembled from three VLIZ
sources: land, internal waters and archipelagic waters. Kept as separate layers,
their slightly different digitalisations leave thin slivers where a position
falls between them. Dissolving them per country removes those seams, collapses
the shared coastline, and shrinks the layer substantially.

VLIZ publishes archipelagic waters separately, and internal waters alone has no
polygons for archipelagic states such as Indonesia and the Philippines, so the
archipelagic layer must be included.

## Rebuilding

Requirements: Node >= 20 and the dev dependencies.

```sh
npm install          # shapefile, polygon-clipping
```

### 1. Territorial sea (shipped)

```sh
node tools/convert-world.js --shp <dir>/eez_12nm_v4.shp \
  --out lib/geodata/territorial-seas-world.json.gz
```

### 2. Coast sources (converted caches in geodata/, not shipped)

```sh
# land: World Countries 2014, the normal baseline of the boundaries
node tools/fetch-vliz-wfs.js --layer worldcountries_esri_2014 \
  --out geodata/vliz-land-esri-2014.geojson \
  --fix "Mauritius=Republic of Mauritius,Western Sahara=Morocco"
node tools/convert-world.js --geojson geodata/vliz-land-esri-2014.geojson \
  --out geodata/land-world.json.gz

# internal waters
node tools/convert-world.js --shp <dir>/eez_internal_waters_v4.shp \
  --out geodata/internal-waters-world.json.gz

# archipelagic waters
node tools/fetch-vliz-wfs.js --layer eez_archipelagic_waters \
  --out geodata/vliz-archipelagic-waters.geojson
node tools/convert-world.js --geojson geodata/vliz-archipelagic-waters.geojson \
  --out geodata/archipelagic-waters-world.json.gz
```

### 3. Dissolve the coast (shipped)

```sh
node tools/build-coast.js
```

Unioning the three sources whole works for most countries, retrying with
progressively coarser simplification where the raw rings are too dense for the
polygon clipper. Countries with very many rings (currently Canada, ~100k) fall
back to a 5-degree grid: each cell is dissolved independently and the results
are concatenated.

### 4. Regenerate the display regions (shipped)

```sh
node tools/build-resources.js
```

## Sources

- Territorial seas: VLIZ `World_12NM_v4_20231025.zip`
  (doi:10.14284/633)
- Internal waters: VLIZ `World_Internal_Waters_v4_20231025.zip`
  (doi:10.14284/631)
- Archipelagic waters: VLIZ WFS `MarineRegions:eez_archipelagic_waters`
  (doi:10.14284/629)
- Land: VLIZ WFS `MarineRegions:worldcountries_esri_2014` (World Countries 2014)

Downloads: <https://www.marineregions.org/downloads.php>.
WFS: <https://geo.vliz.be/geoserver>. All CC-BY 4.0.

Re-run the steps above whenever a new dataset version is released, then commit
the updated `lib/geodata/*.json.gz` files.
