# CDL on Lonboard / deck.gl-raster

Browser-side, viewport-driven, per-class-pickable rendering of USDA's
Cropland Data Layer (CDL) from Microsoft Planetary Computer — no tile
server, no derived data, no hosting. Plus a small set of Python notebooks
documenting the equivalent and partial approaches in
[lonboard](https://developmentseed.org/lonboard/).

The browser app is the headline. The notebooks are the trail of how we
got here (and a record of what's still missing in the Python wrapper).

```
+-------------+   STAC items   +---------------+   signed Range reads
| MPC STAC    |---------------▶| browser app   |◀--+---------------+
| usda-cdl    |                | (deck.gl-     |   | Azure blobs   |
+-------------+                | raster +      |   | (per-tile     |
                               | maplibre)     |   |  COGs +       |
+-------------+   class table  |               |   |  overviews)   |
| GEE STAC    |---------------▶|               |   +---------------+
| catalog     |                +-------+-------+
+-------------+                        │
                                       │ click any pixel
                                       ▼
                                  out-of-band
                                  Range read +
                                  proj4 lon/lat -> CDL pixel
                                  -> class code + crop name
```

---

## Why this exists

USDA NASS publishes CDL annually as zipped CONUS-wide GeoTIFFs. Microsoft
Planetary Computer mirrors that as a STAC collection (`usda-cdl`) with
~1095 per-tile Cloud-Optimized GeoTIFFs per year, each ~90×90 km in EPSG:5070
Albers with built-in overview pyramids. The data has every property you want
for a fast browser viewer (Range-readable, COG-tiled, paletted uint8, embedded
colormap) — except it's *sharded*, not one global COG. Server-side mosaic tile
APIs exist but lose per-pixel class codes (you only get the rendered RGB).

DevSeed has the JS side of this solved in
[`deck.gl-raster`](https://github.com/developmentseed/deck.gl-raster):
`MosaicLayer` indexes many COGs spatially (Flatbush), fans out viewport-driven
byte-range reads per source, and uses each source's own overview pyramid. The
[`naip-mosaic` example](https://github.com/developmentseed/deck.gl-raster/tree/main/examples/naip-mosaic)
demonstrates the pattern against MPC's NAIP collection.
[`lonboard`](https://developmentseed.org/lonboard/) hasn't wrapped this into
a Python constructor yet (no `RasterLayer.from_stac_items`), so the
Python-side notebooks here can render only single tiles or
state-scale multi-layer stacks.

This repo ports the JS pattern to CDL with three additions:

- a 256-entry palette LUT from the GEE STAC catalog (single-band paletted
  uint8 with a custom `cdlPaletteLookup` shader module)
- out-of-band per-pixel picking (lon/lat → EPSG:5070 → `geotiff.index()` →
  `fetchTile` → read one byte → `palette.names[code]`)
- a viewport-strict crop dashboard with category filtering and acreage math

---

## Quick start (browser app)

```bash
cd web
npm install

# One-time: build the 256-entry palette LUT from the GEE STAC catalog.
uv run scripts/gen_palette.py

# Re-run when SAS tokens expire (~1 hour). Defaults to 2021 / CONUS.
uv run scripts/gen_stac.py
# uv run scripts/gen_stac.py --year 2020 --bbox -125 24 -66 50

npm run dev   # http://localhost:5454
```

### What the app does

- **CONUS mosaic** at full 30 m resolution. Pan/zoom anywhere; overviews
  are used at low zoom (the inner `COGLayer` picks the right pyramid level
  per source based on screen resolution).
- **Crops-in-viewport dashboard** (top-left, collapsible) with color
  swatch, crop name, acreage, pixel count, and percentage. Recomputes on
  every pan/zoom and as new tiles land. Acreage from each tile's affine
  transform: `pixels × |a| × |e| × 0.000247105` (m²-to-acres).
- **Category filter** with checkboxes for 14 USDA-style groups
  (Field crops, Cereals, Oilseeds, Legumes, Forage, Fruits/Tree Nuts,
  Vegetables, Developed, Forest, Shrubland, Pasture, Wetlands, Water,
  Barren), plus an "Other / fallow / no-data" bucket. Show all / Hide all
  buttons. Filter affects both the rendered map and the dashboard counts.
- **Click any pixel** → bottom-center popup with crop name, CDL class code,
  and lon/lat.
- **Basemap labels on top** of the raster — the deck.gl layer is inserted
  before the first symbol layer in whatever maplibre style is loaded.

### Why Python is in the loop at all

Pre-baking SAS-signed hrefs into the JSON sidesteps MPC's
sign-endpoint rate limit. Runtime signing at CONUS zoom triggers ~1095
parallel sign requests, which MPC throttles aggressively (429 cascades).
Pre-baking is one Python step per ~1 hour; the rest of the app is pure
JS/TS. See `.claude/memory/MEMORY.md` for the long version of why this
matters.

---

## Quick start (Python notebooks)

The notebooks document four approaches; all share the same dependencies.

```bash
uv run jupyter lab     # opens the notebook tree
```

| Notebook | What it does | Status |
|---|---|---|
| `raster-cog-nlcd-server.ipynb` | The reference: one big NLCD COG → `lonboard.RasterLayer.from_geotiff`. Works because NLCD is a single COG with a built-in pyramid. | Working. The shape we want for CDL. |
| `raster-cog-cdl-pc.ipynb` | Same pattern, one CDL tile from MPC. Pickable, interactive, but only ~90 km of CDL. | Working. |
| `deprecated/cdl-multi-rasterlayer.ipynb` | N × `RasterLayer.from_geotiff` per STAC item in a bbox. State-scale (~30–50 tiles) works; CONUS doesn't. | Working at state scale. |
| `deprecated/cdl-lazycogs-mosaic.ipynb` | `lazycogs.open()` materializes a single reprojected xarray over many COGs → one `BitmapLayer`. CONUS works but is static (not viewport-driven). | Working but not interactive. |
| `cdl-stac-mosaic.ipynb` | Pre-generates a minimal STAC JSON in the shape `deck.gl-raster`'s `MultiRasterTilesetDescriptor` expects, ships the best lonboard rendering achievable today (multi-RasterLayer), and includes a one-line swap comment for when a `from_stac_items` constructor exists in lonboard. | Working at state scale. |

The browser app under `web/` is the next link in the chain: it shows what
the Python side *would* look like if lonboard wrapped `MosaicLayer`.

---

## Repo layout

```
.
├── README.md                       this file
├── NEXT.md                         decision criteria for the next session
├── pyproject.toml                  Python deps for the notebooks
├── raster-cog-nlcd-server.ipynb    single big COG (NLCD) — the reference
├── raster-cog-cdl-pc.ipynb         single CDL tile via MPC
├── cdl-stac-mosaic.ipynb           STAC-JSON prep + best-today lonboard render
├── deprecated/                     state-scale and static-mosaic prototypes
├── .claude/memory/MEMORY.md        verbose retrospective + design notes
└── web/                            the browser app
    ├── package.json                vite + react 19 + maplibre + DevSeed packages
    ├── index.html
    ├── vite.config.ts              port 5454; build target esnext (TLA in workers)
    ├── tsconfig.json
    ├── scripts/
    │   ├── gen_stac.py             pystac-client + planetary-computer.sign_inplace
    │   └── gen_palette.py          GEE STAC -> 256-entry RGBA + class names
    └── src/
        ├── main.tsx                React root
        ├── App.tsx                 map, MosaicLayer, dashboard, picking, filter
        ├── proj.ts                 EPSG:5070 + lon/lat <-> Albers transforms
        ├── stats.ts                per-tile histograms + viewport-strict aggregation
        ├── pick.ts                 out-of-band click -> CDL class code + crop name
        ├── cdlShaders.ts           r8unorm + cdlPaletteLookup shader module
        ├── categories.ts           CDL code -> USDA category grouping
        ├── minimal_stac.json       generated, GITIGNORED (SAS-signed, ~1hr TTL)
        └── palette.json            generated (refresh only on GEE updates)
```

---

## Architecture (browser app)

### Stack

| Layer | What | Notes |
|---|---|---|
| Storage | Azure blobs (`landcoverdata.blob.core.windows.net/usda-cdl/`) | Per-tile COGs, ~90×90 km in EPSG:5070, embedded overview pyramids + USDA colormap |
| Catalog | MPC STAC (`/api/stac/v1`) | `usda-cdl` collection; SAS tokens via `/api/sas/v1/sign` (rate-limited) |
| Pre-bake | `pystac-client` + `planetary-computer.sign_inplace` | Run hourly to refresh SAS tokens |
| COG reader | [`@developmentseed/geotiff`](https://www.npmjs.com/package/@developmentseed/geotiff) | Range requests, TIFF parser, web-worker decoders (LERC / Deflate / Zstd) |
| Mosaic | [`@developmentseed/deck.gl-geotiff`](https://www.npmjs.com/package/@developmentseed/deck.gl-geotiff) | `MosaicLayer` (Flatbush spatial index) + `COGLayer` (pyramid-aware tile fetching) |
| Render | [`@developmentseed/deck.gl-raster`](https://www.npmjs.com/package/@developmentseed/deck.gl-raster) | `RasterTileLayer`, shader-module render pipeline, in-shader EPSG:5070 → Web Mercator |
| GPU | `@luma.gl/core` + WebGL2/WebGPU | r8unorm class texture + 256×1 RGBA palette LUT |
| Map | maplibre-gl + react-map-gl/maplibre + `@deck.gl/mapbox` | `MapboxOverlay` interleaves the deck layer beneath basemap labels |
| Reproject | `proj4` (TS) + `@developmentseed/proj` | Picking + per-tile bbox projection (TS); GeoTIFF CRS resolution (deck.gl-raster) |

### Render path (per frame)

1. `MosaicLayer` asks: which of the 1095 sources intersect the current viewport bbox? (Flatbush.)
2. For each: our `getSource` returns a cached `GeoTIFF` instance (or opens one — 16 KB header Range read).
3. `renderSource` returns a `COGLayer` per source. The COGLayer's inner `RasterTileLayer` picks the right overview level for current screen resolution.
4. For each visible tile: our `getTileData` does the Range fetch + LERC/Deflate decode, records the tile's histogram + lon/lat bbox in `stats.ts`, uploads as r8unorm to the GPU.
5. `renderTile` returns `[CreateTexture, cdlPaletteLookup]`. The shader samples the class index, looks up the palette LUT, discards alpha=0 (background + filtered-out classes).
6. deck.gl composites into maplibre's canvas, beneath the first symbol-layer in the active style.

### Picking

Deck.gl's normal picking would only give us the rendered RGB color of a pixel. We do an out-of-band read instead:

1. maplibre `onClick` → `(lng, lat)`.
2. Linear bbox-scan over 1095 items → which source COG covers the point.
3. `getCachedGeoTIFF(href)` → already-opened `GeoTIFF`.
4. `proj4(lng, lat)` → EPSG:5070 meters.
5. `geotiff.index(x, y)` → full-res `(row, col)`.
6. Derive `(tx, ty, localRow, localCol)` within the source's internal tile grid.
7. `geotiff.fetchTile(tx, ty)` — usually a cache hit if currently visible.
8. Read one byte → CDL class code → `palette.names[code]` → popup.

### Dashboard

Every tile uploaded to the GPU also feeds a 256-bucket histogram into module-level state (`stats.ts`), keyed by source and overview level (a switch in overview level for a source drops the prior level's tiles — no double-counting). Each entry stores the tile's lon/lat bbox (4 corners projected from EPSG:5070).

`aggregateInViewport(bbox)` sums histograms across tiles whose bbox intersects the viewport. Acreage per class = `pixel_count × |transform[0]| × |transform[4]| × 0.000247105`. Holds at any overview level because pixel area scales with overview.

Granularity is per-tile, not per-pixel: edge tiles that overlap the viewport contribute their full pixel count. Good enough for "what dominates this view"; for survey-grade acreage you'd add per-pixel viewport clipping.

---

## Known footguns

- **SAS tokens expire ~1 hour after `gen_stac.py` runs.** Symptom: 403 / "Server failed to authenticate the request" in the network tab. Fix: re-run the script.
- **MPC's `usda-cdl` collection caps at 2021** despite USDA publishing through 2024. The MPC mirror is stale.
- **Bilinear filtering on class codes produces garbage.** Both textures (class index and palette LUT) use nearest filtering. A "class 1.5" pixel is nonsense.
- **At CONUS zoom (z<5), all 1095 sources are in view.** Each contributes its coarsest overview tile. Slow first paint but not broken — the layer's pyramid-aware loading is doing exactly the right thing for the data shape; there's no global pyramid because the data isn't one COG.
- **Category groupings overlap** (e.g. soybeans are both an oilseed and a legume in USDA's classifications). Toggling one category may partially turn on/off a code that's also in another category — the UI shows an indeterminate checkbox state for that.

---

## What's not (yet) shipped

- **GitHub Pages deployment.** Blocked by the 1-hour SAS TTL. Options: runtime sign helper (rate-limit risk; requires a concurrency limiter + retries), or a daily GitHub Action cron (broken between regens). Neither is clean.
- **`r8uint` + `usampler2D` shader pipeline.** The `land-cover` example in `deck.gl-raster` uses an integer-sampled pipeline that's cleaner than our `r8unorm` + scale-to-index approach. Worth lifting — the shader code is example-local, not exported from the npm package. ~150 LOC port.
- **Per-pixel viewport clipping in stats.** Current granularity is per-tile.

---

## Credits

The heavy lifting is all DevSeed:

- [`@developmentseed/deck.gl-raster`](https://github.com/developmentseed/deck.gl-raster) — render engine + mosaic + COG layer
- [`@developmentseed/deck.gl-geotiff`](https://github.com/developmentseed/deck.gl-raster/tree/main/packages/deck.gl-geotiff) — `MosaicLayer` + `COGLayer`
- [`@developmentseed/geotiff`](https://github.com/developmentseed/deck.gl-raster/tree/main/packages/geotiff) — pure-JS COG reader
- [`lonboard`](https://github.com/developmentseed/lonboard) — the Python wrapper this app is "the missing constructor for"
- [`obstore`](https://github.com/developmentseed/obstore) + [`async-geotiff`](https://github.com/developmentseed/async-geotiff) — the Python equivalents (notebooks)
- [Microsoft Planetary Computer](https://planetarycomputer.microsoft.com/) — for hosting CDL as STAC + sharded COGs
- [USDA NASS](https://www.nass.usda.gov/Research_and_Science/Cropland/SARS1a.php) — the underlying CDL data
- [Google Earth Engine STAC catalog](https://storage.googleapis.com/earthengine-stac/catalog/USDA/USDA_NASS_CDL.json) — the class palette + names
- [CartoCDN basemaps](https://carto.com/basemaps) — Positron / Voyager / dark-matter styles
