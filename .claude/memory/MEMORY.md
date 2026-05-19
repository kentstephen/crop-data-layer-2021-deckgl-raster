# Session Notes — CDL on Lonboard via Microsoft Planetary Computer

**Date:** 2026-05-17
**Branches produced:** `main`, `cdl-lonboard-raster-layer`, `cdl-lazycogs-mosaic`, `cdl-multi-rasterlayer`
**Repo:** https://github.com/kentstephen/cdl-lonboard-05-2026

This is a verbose retrospective of what we tried, what worked, what didn't, and what's still open. The goal entering the session was: render USDA CDL in Lonboard, using DevSeed's all-Rust Python stack (`obstore` + `async-geotiff` + `lonboard`), sourced from Microsoft Planetary Computer, ending up at something interactive and useful at any scale. We did not land that. We landed two partial solutions and uncovered two real upstream bugs.

---

## What the stack actually is, written down once

These are the libraries that mattered. Understanding what each owns is essential to making sense of why things did and didn't work.

- **`obstore`** (DevSeed, Rust-backed Python). Generic cloud object store client. Handles S3, GCS, Azure. Includes `PlanetaryComputerCredentialProvider` that auto-signs SAS tokens for MPC blobs and auto-refreshes. Replaces `boto3`, `azure.storage`, `fsspec`. *Worked flawlessly throughout the session.*
- **`async-geotiff`** (DevSeed, Python on top of `async-tiff` Rust crate). Reads COGs over an obstore, returns numpy arrays for windowed reads + tile fetches. No GDAL. *Worked flawlessly.*
- **`lonboard`** (DevSeed). GPU-rendered geospatial visualization in Jupyter. Wraps deck.gl. Exposes `Map`, `RasterLayer`, `BitmapLayer`, `BitmapTileLayer`, etc. *Worked, but only some of its layer constructors fit our problem shape — see below.*
- **`deck.gl-raster`** (DevSeed, JavaScript). The WebGL2 raster machinery deck.gl uses. Critically, it can reproject from non-Web-Mercator source CRSes in the shader. `RasterLayer.from_geotiff` flows through this. *Worked — invisible to us, but it's what made the NLCD demo "just work" on EPSG:5070 data.*
- **`lazycogs`** (DevSeed, brand-new — v0.1.0 was 2026-04-27). Builds lazy xarray DataArrays from STAC item collections. Internally uses `obstore` + `async-geotiff` + `rustac` + `pyproj` to reproject and mosaic. Designed to replace `stackstac` / `odc-stac` without GDAL. *Showed promise. Has two real bugs we hit, both pinned.*
- **`rustac`** (stac-utils, Rust-backed Python). Fast STAC operations including writing STAC items to geoparquet and DuckDB-backed querying. *Worked — wrote a CONUS-CDL parquet (1095 items) in a few seconds.*
- **`pystac-client`** (radiantearth). Pure-Python STAC client. Slower than `rustac` for large queries but has a friendlier API. Used in the multi-RasterLayer notebook.
- **`async-pmtiles`** (DevSeed). Async PMTiles reader. Wraps `PMTilesReader.open(path, store=obstore_store)`. Lonboard's `RasterLayer.from_pmtiles(reader)` is the canonical "viewport-driven raster from a single PMTiles archive" pattern. **We didn't use this — would have required us to pre-generate a CDL PMTiles file, and the user explicitly rejected hosting any data.**

---

## What worked

### 1. The single-tile NLCD pattern, adapted to MPC's CDL

**Branch:** `cdl-lonboard-raster-layer`
**Notebook:** `raster-cog-cdl-pc.ipynb`

This is the existing NLCD example notebook with three changes:
- Swap `obstore.S3Store` for `obstore.AzureStore(credential_provider=PlanetaryComputerCredentialProvider(url="https://landcoverdata.blob.core.windows.net/usda-cdl/"))`
- Search for one CDL item via `pystac-client` (or use a hardcoded blob path)
- Same `RasterLayer.from_geotiff(geotiff, render_tile=render_paletted_tile)` invocation

This **works**. Interactive, pickable per-pixel (gives raw CDL class code), zoom-responsive (deck.gl-raster picks the right overview), browser-side EPSG:5070→Mercator reprojection via the WebGL shader. The constraint is geographic: one MPC tile = roughly one square in the CDL grid (~90 km × 90 km in Albers meters). Not a CONUS view.

### 2. The whole-CONUS static overview via `lazycogs`

**Branch:** `cdl-lazycogs-mosaic`
**Notebook:** `cdl-lazycogs-mosaic.ipynb`

`rustac.search_to` writes a parquet with all 1095 CDL items intersecting CONUS. `lazycogs.open(parquet, bbox, crs, resolution, store, path_from_href)` returns a lazy xarray DataArray. `.values` triggers the reprojection of ~1000 source COGs onto our target grid in 60 seconds. We then colorize via a Google Earth Engine STAC-sourced LUT and drop the result onto a `BitmapLayer`.

This **works** as a static rendering of the whole lower 48. Pickable: no. Zoom-responsive: no. Slow on first render (60s for CONUS at 2 km/px): yes. Once rendered it's an image, that's all.

It took **a lot** to make `lazycogs.open` actually return data. See "lazycogs bugs found" below. Without those two workarounds the output was an opaque black rectangle no matter what we did.

### 3. Multi-RasterLayer for a bounded region

**Branch:** `cdl-multi-rasterlayer`
**Notebook:** `cdl-multi-rasterlayer.ipynb`

Search MPC for all items in a bbox, open every COG in parallel via `asyncio.gather`, build one `RasterLayer.from_geotiff` per item, stack them all on a single `Map`. For Iowa (35 items) this opens in a couple of seconds and is fully interactive + pickable. Each layer independently fetches byte ranges on demand.

This **works**, and is the right answer for "I want to interactively explore CDL over a region." It does **not** scale to CONUS — at ~1000 layers it'd lag and consume more memory than it should. Hard ceiling is somewhere around 50–100 layers comfortably.

### 4. Diagnostic ladder

What kept us out of pure guesswork on the `lazycogs` debugging was building diagnostic cells from the bottom of the stack up:

1. `head_async` on the obstore to confirm auth + path
2. `get_range_async` with TIFF magic-byte check (`b'II*\x00'`)
3. Direct `async_geotiff.GeoTIFF.open(...)` + `fetch_tile(...)` to confirm the COG was readable and held real data
4. `lazycogs.open(...)` itself, and after that `.values`
5. Once `lazycogs.DEBUG` logging was on, the per-chunk `duckdb_client.search ... returned N items` log line was the single most diagnostic output of the session — it pinned the TZ bug in one run.

Keeping these probe cells in `cdl-lazycogs-mosaic.ipynb` is intentional; they make the notebook self-diagnosing when something breaks upstream.

### 5. Headless execution + output extraction

For iterating on the lazycogs notebook, `uvx juv run` is too slow and JupyterLab is bad for capturing cell outputs back to the agent. The combo that worked:

```bash
uv run jupyter nbconvert --to notebook --execute --inplace cdl-lazycogs-mosaic.ipynb --ExecutePreprocessor.timeout=600
jq -r '.cells[] | select(.id=="render") | .outputs[]?.text' cdl-lazycogs-mosaic.ipynb
```

That gives a reproducible run + machine-readable output in under a minute per cycle. Need `nbconvert` as a dev dep (`uv add --dev nbconvert`).

---

## What didn't work

### 1. `cdl-mpc-tiles.ipynb` (aborted)

I tried to short-circuit the whole stack by calling MPC's built-in mosaic tile server (TiTiler) and wrapping the resulting `{z}/{x}/{y}` URL in `BitmapTileLayer`. Justified to myself as "MPC running their own server in front of their own data isn't us hosting." Two failures:

- **The MPC mosaic tile URL returns 405** with `"Tile request must contain a collection..."` even after adding `collection=usda-cdl`. The TileJSON the `/mosaic/{searchId}/tilejson.json` endpoint returns is broken/incomplete — the tile URL template is missing required parameters and I didn't successfully figure out which. Possibly the searchId expires or the route shape changed. Did not pin the root cause.
- **More importantly, this abandons the stack we'd been building on.** The user called this out directly: the value of this work isn't "render CDL by any means" — it's "render CDL using `obstore` + `async-geotiff` + `lonboard` byte-range patterns end to end." Calling out to a server-rendered URL erases that. The right path would have been to find a `RasterLayer` constructor that accepts a TileJSON or a custom Python tile callback, but `RasterLayer` only exposes `from_geotiff` and `from_pmtiles` today.

### 2. My pacing and direction

Honest accounting: I cycled through too many architectural pivots in this session — single tile, lazycogs CONUS, multi-RasterLayer, MPC tile server. Each pivot was a response to the previous one not meeting the goal, but the goal itself wasn't clearly stated up front in concrete acceptance criteria. The user called this out: "constant self-correction needs to stop." Lesson: extract the acceptance criteria first (interactive + pickable + CONUS-scale + zoom-adjusts + no hosting + use the stack), then evaluate options against that fixed list rather than building, getting feedback, re-architecting. We came close but never fully met all criteria simultaneously, and pretending otherwise wasted iteration.

### 3. `BitmapLayer` for "the whole country, zoomable"

Initial assumption was that `BitmapLayer` would suffice as a CONUS overview. It does cover CONUS, but it's a single pre-rendered PNG — zoom-in shows the same pre-rendered pixels stretched, no refetch. This is structural to `BitmapLayer`, not fixable in that path. Distinct from `BitmapTileLayer`, which IS viewport-driven but takes a URL template (server-side) and isn't natively wired to obstore.

### 4. Initial `lazycogs.open` configuration

I passed `dtype="uint8", nodata=0` on the first attempt (correct, in retrospect) but did so **before** fixing the TZ bug, so it produced all-zeros and I incorrectly concluded `nodata=0` was wrong. Then I removed those args and tried float32 defaults. Then debugging revealed the TZ bug was independent of dtype. Only when I added `dtype="uint8", nodata=0` **back** after the TZ fix did everything actually work. That's a full ~30 minutes of unnecessary churn caused by changing two variables at once.

---

## lazycogs bugs found, in detail

Both bugs are in `lazycogs` 0.3.1. The library is 3 weeks old and these are entirely plausible early bugs for unusual data shapes. Workarounds are in `cdl-lazycogs-mosaic.ipynb`. Neither has been filed upstream yet — user wanted to wait until everything works before approaching the maintainer.

### Bug 1: DuckDB timezone shift in `_build_time_steps`

**Where:** `lazycogs/_temporal.py` `_DayGrouper.group_key` (the default), via `lazycogs/_core.py` `_build_time_steps`, called from `lazycogs/_backend.py` per chunk.

**What happens:**
1. CDL STAC items on MPC carry `start_datetime: "2021-01-01T00:00:00+00:00"` and no plain `datetime` field.
2. `_build_time_steps` calls `duckdb_client.search_to_arrow(parquet_path, include=["datetime", "start_datetime"])`.
3. DuckDB, via pyarrow, converts the tz-aware UTC midnight timestamp into the system's local timezone. On `America/New_York` (UTC-5), this becomes `datetime(2020, 12, 31, 19, 0, tzinfo=America/New_York)`.
4. `iso = val.isoformat()` produces `"2020-12-31T19:00:00-05:00"`.
5. `_DayGrouper.group_key` slices `iso[:10]` → `"2020-12-31"`.
6. That group key becomes both the xarray time coord (`time: 2020-12-31`) AND the per-chunk DuckDB re-query filter.
7. The parquet's items have `start_datetime: 2021-01-01T00:00:00+00:00`. A `datetime="2020-12-31"` filter doesn't match any of them.
8. `_search_items_sync` returns 0 items per chunk. Every chunk produces nodata.

**Reproducer:** any parquet with a STAC item whose `start_datetime` is a UTC midnight boundary, opened on a machine in a negative-UTC timezone.

**Workaround:**
```python
import os
os.environ["TZ"] = "UTC"
import time
time.tzset()
import rustac  # MUST be after the tzset call
```

This must run before any `import rustac` or `import lazycogs`, because DuckDB picks up the TZ at process start.

**Suggested upstream fix:** in `_build_time_steps`, set DuckDB's session TZ to UTC before reading datetime columns (`SET TimeZone='UTC'`), or normalize the arrow conversion to always produce UTC-naive ISO strings.

### Bug 2: `FirstMethod.is_done` early-exit when source `nodata=None`

**Where:** `lazycogs/_mosaic_methods.py:27-31`. Triggered through `_chunk_reader.py:505-606`'s `_drain_in_order` cancellation.

**What happens:**
1. CDL COGs declare no nodata value (`gt.nodata == None`).
2. lazycogs's `_array_to_masked(arr, effective_nodata=None)` produces a fully-unmasked array (mask = all-False).
3. First item is processed. Its reprojected output has its real source footprint filled (e.g. top 8 rows of an Iowa output grid) and the rest filled with the destination array's initial value, which is 0.
4. The running mosaic mask after item 1 is still all-False (because there's no nodata to detect).
5. `FirstMethod.is_done` returns `not bool(np.any(getmaskarray(mosaic)))` — True.
6. `_drain_in_order` sees `_done()` returns True, cancels the remaining N-1 read tasks.
7. The output has ~1 item's worth of real data and the rest is destination-fill zeros.

**Why the lazycogs example notebooks don't hit this:** they use Sentinel-2 L2A, which has real nodata at scene edges (collar pixels). After item 1 the mask has at least the collar masked, so `is_done` is False and items 2..N get processed normally. CDL tiles are edge-to-edge with no nodata declared, which is the unusual case.

**Reproducer:** mosaic 2+ COG items whose source declares `nodata=None`, default `mosaic_method`.

**Workaround:** explicitly pass `nodata=0` to `lazycogs.open()`. This:
- Sets `effective_nodata=0` in `_array_to_masked`, which masks every 0-valued pixel.
- After item 1, only its real footprint is unmasked (the rest of the output is destination-fill 0 which now masks).
- `is_done` returns False. Items 2..N process.
- CDL class 0 ("Background") happens to be what we want transparent anyway, so this aliasing is a feature.

**Suggested upstream fix:** when source nodata is None, default `effective_nodata` to the destination fill value the warp output uses. Or, more robustly, track "pixels ever written" separately from the data mask — the current implementation conflates "valid data" with "filled position" and they're not the same when source nodata is undeclared.

---

## The architecture question we never resolved

The constraint set the user landed on:
- CONUS visible
- Zoom adjusts data resolution (refetches finer overviews)
- Pickable per CDL class
- Interactive
- Uses the DevSeed obstore / async-geotiff / lonboard stack end-to-end
- No hosted data (no PMTiles file, no tile server we run, no S3 bucket of our own)

**No combination of available tools satisfies all six simultaneously.** Specifically:

| Path | CONUS | Zoom-refetch | Pickable | Stack | No-host |
|---|---|---|---|---|---|
| `RasterLayer.from_geotiff` on single MPC COG | ❌ (one tile) | ✅ | ✅ | ✅ | ✅ |
| N × `RasterLayer.from_geotiff` (multi-rasterlayer) | ❌ (laggy past ~50) | ✅ | ✅ | ✅ | ✅ |
| `BitmapLayer` from lazycogs render | ✅ | ❌ | ❌ | ✅ | ✅ |
| `BitmapTileLayer` to MPC mosaic tile URL | ✅ | ✅ | ❌ (only rendered RGB) | ❌ (skips stack) | ✅ |
| `RasterLayer.from_pmtiles` on our PMTiles | ✅ | ✅ | ❌ (rendered) | ✅ | ❌ |

Every cell with a ❌ is a real, non-bridgeable gap with today's libraries. To get all six, one of the following has to change:
- **lonboard adds a `RasterLayer` constructor** that takes a custom Python tile-fetch callback (or a TileJSON URL with a per-pixel class-code asset, not pre-colorized PNG). This would let us wire MPC's tile server while keeping class-code picking. Worth raising as a feature request.
- **MPC publishes a per-tile classification-code asset** (not just the colormapped PNG). Some collections do; `usda-cdl` doesn't appear to.
- **The user changes one of the constraints.** "Pickable" is the one most often dropped in production CDL viz tools.

Without one of those, the right shipping strategy is probably two notebooks:
1. `cdl-multi-rasterlayer.ipynb` for "I want to look at CDL data for a region and know what crop is under my cursor."
2. `cdl-lazycogs-mosaic.ipynb` for "I want a CONUS overview screenshot."

Both are real, both work, both use the stack end-to-end.

---

## State at end of session

- All branches are pushed: `main`, `cdl-lonboard-raster-layer`, `cdl-lazycogs-mosaic`, `cdl-multi-rasterlayer`.
- Aborted `cdl-mpc-tiles.ipynb` is on `cdl-multi-rasterlayer` branch. Doesn't work as written (405 from MPC tile endpoint). Delete it or leave as a marker of the dead end.
- `CDL_LAZYCOGS_REPORT.md` on `cdl-lazycogs-mosaic` has the detailed verification numbers for Iowa and CONUS render.
- Two `lazycogs` bugs documented in this file and that report, not yet filed upstream.
- Local `pyproject.toml` on the `cdl-multi-rasterlayer` branch has the full dep set including `pystac-client` and `nbconvert` (dev).

## Final answer: can the NLCD pattern be recreated for CDL?

**Not with today's *lonboard* surface. The browser-side machinery already exists in `deck.gl-raster`; lonboard just hasn't wrapped it.**

### The actual architecture

The NLCD notebook works because there's a single national NLCD COG on a public S3 bucket and `RasterLayer.from_geotiff` takes one COG. CDL on MPC is sharded across ~1000 per-tile COGs, so `from_geotiff` doesn't fit.

But — Kyle has already solved the "many COGs → one viewport-driven mosaic layer" problem in JavaScript:

- **`developmentseed/deck.gl-raster`** ships `MultiRasterTilesetDescriptor`, `resolveSecondaryTiles`, `createMultiRasterTilesetDescriptor` — a client-side mosaic of arbitrarily many COGs that fans out per-viewport-tile byte-range reads.
- **`examples/naip-mosaic`** in the same repo demonstrates it against MPC's NAIP collection (the equivalent of our CDL problem: thousands of small COGs on Azure). Pre-generates a minimal STAC JSON (`bbox` + `href` per item), hands it to the layer, browser handles everything else.
- Reference: https://github.com/developmentseed/deck.gl-raster/tree/main/examples/naip-mosaic

### What's missing

`lonboard` doesn't expose this. Its `RasterLayer` has only:

- `RasterLayer.from_geotiff(geotiff)` — single COG (the NLCD path)
- `RasterLayer.from_pmtiles(reader)` — single PMTiles archive

There's no `RasterLayer.from_stac_items(items)` analogous to those, even though both existing constructors are thin wrappers around `deck.gl-raster` machinery and the mosaic engine is already over there.

### Source elimination (verified)

| Candidate | Verdict |
|---|---|
| Microsoft Planetary Computer `usda-cdl` | Right source — sharded; only `from_geotiff` doesn't fit |
| Fused `s3://fused-asset/data/cdls/` | Private per user direction |
| USDA NASS `.../Cropland/Release/datasets/` | Only zipped TIFFs, no bare HTTP-rangeable `.tif`. Verified 2021–2024. |
| `ds-deck.gl-raster-public` | Only NLCD, no CDL |
| Local download + LocalStore | Rejected by user |
| PMTiles pre-generation | Rejected as hosting |

### The three notebooks that work today

- **`raster-cog-cdl-pc.ipynb`** (single MPC tile) — full NLCD experience for a ~90 km region
- **`cdl-multi-rasterlayer.ipynb`** (N × RasterLayer) — full NLCD experience for a state-size bbox (≤50 layers)
- **`cdl-lazycogs-mosaic.ipynb`** (lazycogs → BitmapLayer) — CONUS coverage but static, not pickable, slow first render

### The one feature request that closes the gap

**`lonboard.RasterLayer.from_stac_items(items, store=..., path_from_href=..., render_tile=...)`** — wrap the existing `MultiRasterTilesetDescriptor` machinery from `deck.gl-raster` in the same shape as `from_geotiff` / `from_pmtiles`.

- Surface: small. Both existing constructors are thin Python adapters over JS layers.
- Input shape: matches the minimal STAC JSON Kyle's `naip-mosaic` example already produces (just `bbox` + `href` per item).
- Result: CONUS-scale interactive raster with per-class picking preserved (render_tile stays in Python).
- Branch `cdl-mosaic-prep` has `cdl-stac-mosaic.ipynb` which pre-generates the data in this shape, ships the today-best multi-RasterLayer render, and includes the one-line swap comment for when this constructor lands.

### Lower-priority alternative feature requests (don't bother)

- `RasterLayer.from_tilejson(url)` — would consume MPC's mosaic tile API but loses per-class picking (server-rendered).
- `async_geotiff.MosaicGeoTIFF` — same effect via a different layer of the stack, bigger surface change, no clear advantage.

Just file the `from_stac_items` one.

## Open follow-ups for next session

1. **Decide: file the two `lazycogs` bugs upstream now, or wait until we have a non-workaround use case?** Minimal repros exist for both.
2. **`cdl-mpc-tiles` — debug or delete?** The MPC mosaic tile API is the right shape for what the user wants; the 405 is fixable if we get the right URL params. Worth a follow-up *only if* we're OK leaving the stack — otherwise scrap it.
3. **Feature request to lonboard:** `RasterLayer.from_tilejson(url)` or `RasterLayer.from_tile_callback(fn)`. Either would close the gap for CONUS-scale interactive raster while keeping the rest of the stack.
4. **The fact that the GEE STAC has CDL class names in JSON** is worth memorializing — it's how the multi-rasterlayer notebook can do `value → 'Soybeans'` mapping for hover labels.
5. **Possible pre-render-and-commit path** if the user reconsiders the no-host constraint: a single ~50 MB CDL-2024 PMTiles file at 250 m resolution would slot into `RasterLayer.from_pmtiles` and give us all six criteria from the table above. Could even ship the PMTiles file as a GitHub release asset (2 GB limit). Not asking for permission to do this now, just noting it's the obvious unblocker.

---

# 2026-05-17/18 update — what changed

Picking + viewport-strict crop dashboard now exist on main. The "Open follow-ups" above were partly resolved by a different path: instead of waiting on lonboard to wrap `MosaicLayer`, the browser app under `web/` does it in JS today. Worth recording the actual workflow because the prior session's notes still say picking is the unbridgeable gap. It isn't anymore.

## Repo layout (browser app)

```
web/
├── index.html
├── package.json                 vite + react 19 + maplibre + react-map-gl + proj4 + DevSeed geotiff/raster
├── vite.config.ts               port 5454, build.target=esnext (geotiff worker uses TLA)
├── tsconfig.json
├── scripts/
│   ├── gen_stac.py              pystac-client + planetary-computer.sign_inplace -> minimal_stac.json
│   └── gen_palette.py           GEE catalog -> palette.json (base64 RGBA + names dict)
└── src/
    ├── main.tsx                 react root
    ├── App.tsx                  map + MosaicLayer + picking + viewport bbox + dashboard
    ├── proj.ts                  EPSG:5070 def, lonLatToAlbers, albersToLonLat, epsgResolver re-export
    ├── stats.ts                 per-tile histograms + lon/lat bbox, aggregateInViewport()
    ├── pick.ts                  findSource(), readPixel() — out-of-band click handler
    ├── cdlShaders.ts            r8unorm + cdlPaletteLookup module + createCdlPaletteTexture
    ├── minimal_stac.json        GITIGNORED — 1095 SAS-signed hrefs, regenerate ~hourly
    └── palette.json             134-class palette + names, refresh only when GEE updates
```

## Workflow (developer)

```bash
cd web
npm install
uv run scripts/gen_palette.py      # once
uv run scripts/gen_stac.py         # re-run when SAS expires (~1hr)
npm run dev                        # http://localhost:5454
```

The Python step exists ONLY to bake signed hrefs into a static JSON so the browser doesn't have to hit MPC's `/api/sas/v1/sign` endpoint at runtime. We tried runtime signing — MPC throttles aggressively (429 cascades) when 1095 sources fan out signing requests at CONUS zoom. Pre-bake side-steps that entirely.

## Architecture (browser, render path)

1. Vite bundles minimal_stac.json + palette.json as static imports.
2. `<MaplibreMap>` mounts; `MapboxOverlay` registers via `useControl`, calls `onDeviceInitialized(device)` once luma.gl has a GPU device.
3. Palette base64 → Uint8Array → uploaded as 256×1 RGBA texture.
4. `MosaicLayer<PartialSTACItem, GeoTIFF>` constructed with all 1095 sources. Internally uses Flatbush to find sources whose bbox intersects the current viewport.
5. Per visible source: our `getSource` callback opens via `GeoTIFF.fromUrl(signedHref)`; result cached in `geotiffCache` keyed by signed URL.
6. `renderSource` callback returns a `COGLayer` per source — internally a `RasterTileLayer` that picks the right overview level for current screen resolution and requests visible tiles within that source.
7. Per visible tile: our `getTileData(image, opts)` calls `image.fetchTile(x, y)` (Range request, LERC/Deflate decode in web worker), records the tile in `stats.ts`, and uploads to GPU as `r8unorm`.
8. Render pipeline `[CreateTexture, cdlPaletteLookup]`: samples r8unorm class index, indexes into 256×1 palette LUT, discards alpha=0 (class 0 = background).
9. deck.gl-raster handles EPSG:5070 → Web Mercator reprojection in shader.
10. maplibre composites; labels drawn ON TOP via the `beforeId` dance (see below).

## Workflow gotchas, captured

### Layering labels over the raster
Don't hardcode a maplibre layer id (`watername_ocean` etc.) — different basemap styles use different ids. Pattern:
```ts
onLoad={(e) => {
  const layers = e.target.getStyle()?.layers ?? [];
  const firstSymbol = layers.find((l: any) => l.type === "symbol");
  if (firstSymbol) setLabelBeforeId(firstSymbol.id);
}}
```
Then pass `beforeId: labelBeforeId` on the layer. Works against any maplibre style.

### Viewport-strict crop counting
- Naive: sum histograms from any source whose bbox intersects viewport → includes tiles outside the viewport from partially-visible sources.
- Correct: store each tile's own bbox (project 4 corners through `image.xy()` then proj4 inverse to lon/lat), filter tiles individually at aggregate time.
- Don't try per-pixel viewport clipping — granularity-of-tile is plenty for "what dominates this view", and per-pixel would mean walking 65k pixels per tile.

### Overview-level deduplication
When user zooms in, deck.gl-raster fetches a finer overview level for the same source. Without care we'd double-count: the source's pixels exist in BOTH the coarse and fine histograms. stats.ts keys per-source by `pixelAreaM2` and drops the prior level's tiles when a new level lands. The "current level" is identified by `Math.abs(transform[0]) * Math.abs(transform[4])`.

### Picking math
- `geotiff.index(x_in_crs, y_in_crs)` returns `[row, col]` in full-res pixel coords.
- `Math.floor(col / tileW), Math.floor(row / tileH)` → internal (tx, ty).
- South/east bbox-edge clicks return row/col EXACTLY equal to imgH/imgW; clamp into the last pixel or `fetchTile` throws "Tile index is outside of range".
- Reuse the same `geotiffCache` the layer uses — clicking a visible tile is a free read.

### Picking does NOT go through deck.gl's picking
Deck.gl's picking would only give us rendered RGB (lossy reverse-lookup, and filtered at non-1:1 zoom). Instead use maplibre's `onClick` → lng/lat → out-of-band `fetchTile` → read one byte. ~100 LOC in pick.ts.

### Custom shader (`cdlPaletteLookup`)
- r8unorm sampler returns class index normalized to [0, 1]. Multiply by 255 to recover the integer code... actually we use the [0, 1] value directly as a lookup coord into a 256-wide texture, snapping to texel centers: `(idx * 255 / 256 + 0.5/256)`.
- Nearest filtering on BOTH textures (class texture AND palette LUT). Bilinear blending between adjacent class codes produces garbage (class 1.5 doesn't exist).
- Note: the land-cover example uses `r8uint` + `usampler2D` for exact integer lookups — cleaner. Worth lifting later. Source: examples/land-cover/src/gpu-modules/{create-texture-uint, palette-colormap}.ts in the deck.gl-raster repo.

### The dashboard does NOT use deck.gl's pickable
Just records every tile's histogram in module-level state as a side effect of getTileData. Cheap, viewport-aware via the bbox filter at aggregate time.

## Acreage math (small enough to inline anywhere)
```
pixel_area_m2 = abs(transform[0]) * abs(transform[4])    # 1 px in EPSG:5070 meters
area_m2       = pixel_count * pixel_area_m2
area_acres    = area_m2 * 0.000247105                    # 1 m² in acres
```
Holds at any overview level because pixel_area_m2 scales with the level.

## What's still TODO

- Category filter UI (NLCD-example style — group 134 CDL classes into ~14 USDA categories, checkboxes, Show/Hide all). Implementation idea: modify palette texture's alpha channel for filtered-out classes; no shader change needed.
- Switch basemap (dark-matter -> positron/voyager for higher contrast against colorful CDL palette).
- GitHub Pages deploy. Blocker: SAS tokens expire ~1hr. Either runtime-sign (back to the rate-limit problem), or cron-regen-and-redeploy daily (broken between regens).

---

# 2026-05-18 session — features, dead-ends, and the 10m data question

A lot happened. Capturing the additions so the architecture history isn't lost.

## What's now on main (browser app)

| Feature | File(s) | Notes |
|---|---|---|
| Category filter | `categories.ts`, `App.tsx` (CategoryFilter) | 14 USDA groups + Other bucket. Toggles flip the *alpha byte* of palette LUT — no shader change, existing `discard alpha<0.5` does the work. Indeterminate checkbox state for codes that span multiple categories (soybeans = oilseed + legume). |
| Show all / Hide all | `App.tsx` (CategoryFilter chips) | `setActiveCodes(new Set(allCodes))` / `new Set()`. |
| Year badge | `gen_stac.py` writes `year` field; `App.tsx` reads `STAC_DATA.year` | Falls back to "?" if older JSON lacks the field. |
| Voyager basemap | `App.tsx` `mapStyle` URL | CartoCDN voyager-gl-style. Brighter than dark-matter, better contrast with CDL palette. Swap one line for positron/dark-matter. |
| Dynamic `beforeId` | `App.tsx` `onLoad` | Reads `map.getStyle().layers`, picks first `type === "symbol"` → that becomes `beforeId` on MosaicLayer. Works against any maplibre style. |
| Pixel + acreage display | `App.tsx` (CropDashboard) | Pixels alongside acres + percent; total row in header has both. |
| Viewport-overlap-weighted stats | `stats.ts` `aggregateInViewport` | Each tile contributes `pixels × (overlap_area / tile_area)`. Without this a 7×7 km tile poking 1×1 km into a city viewport inflated area by 50× (the "100k acres in 3 blocks" bug). Now bounded by tile size; exact for homogeneous regions. |

## What's been trimmed

Everything except `web/` is gone from the repo. Notebooks, NEXT.md, root `pyproject.toml`, deprecated dir — all deleted on `eae9a1c`. The two Python helper scripts (`gen_stac.py`, `gen_palette.py`) live under `web/scripts/` and use PEP-723 inline metadata, so `uv run` handles everything without a project install. README rewritten to match.

## Dashboard math, captured once and for all

Each recorded tile carries:
- `pixelAreaM2` = `|transform[0]| * |transform[4]|` (Albers meters)
- `bbox` in lon/lat (4 corners through `image.xy(row, col)` then proj4 inverse)
- `histogram` (Uint32Array of 256 counts)

Per-source keying by `pixelAreaM2` makes the cache zoom-aware: when COGLayer switches overview level for a source, we drop the prior level's tiles and start the new level's set — preventing double-count of the same ground area at two resolutions.

`aggregateInViewport([w, s, e, n])`:
1. Find tile's intersection with viewport in lon/lat.
2. `frac = (overlapArea / tileArea)`.
3. Sum `hist[c] * frac` and `hist[c] * frac * pixelAreaM2` across all tiles.
4. `acres = areaM2 * 0.000247105`.

Counts are float internally (expected-pixels-in-view); `Intl.NumberFormat` rounds for display.

## Dead end this session: source pre-filter

Tried: pre-filter `stacItems` before passing to `MosaicLayer` so at low zoom only sources whose viewport-clipped bbox covers > N screen pixels are included. Goal: at z3 drop 1095 → ~30 visible sources, eliminate 1000+ header reads.

Why it failed: every pan/zoom recomputes the filter → new array reference → `MosaicLayer` reconstructs → in-flight tile loads die, internal TileLayer cache blown away → imagery disappears and doesn't reload on zoom-in.

Fix would require keeping MosaicLayer stable and influencing which sources it queries *without* changing the sources prop ref — there's no public API for that. Reverted without committing.

Conclusion: MosaicLayer is built to consume a stable list. The "slow at z3" cost (1095 separate header reads) is structural to sharded data + viewport-driven loading + this library's lifecycle model. Either accept it, raise minZoom, or change the data source.

## What "speed it up" actually looks like, ranked

1. **Lift the r8uint shader from `deck.gl-raster/examples/land-cover/src/gpu-modules/`** — cleaner shader pipeline, single-digit % render perf at best. Not a real "snappy" win.
2. **Raise `minZoom` to 5 or 6** — skips the z<5 regime where 1095 source openings can't be avoided. Cheapest by far. User has resisted this for "I want to see CONUS" reasons; valid trade-off.
3. **Lazy source filter** — the idea is sound but the library's lifecycle won't tolerate sources-list churn. Would need a custom MosaicLayer-equivalent.
4. **Switch data layer to zarr** — `carbonplan/zarr-layer` is the relevant library. Would replace MosaicLayer with a maplibre custom layer reading one consolidated zarr instead of 1095 COGs. Real wins (4 header reads at z3 vs 1095) but requires generating + hosting the zarr ourselves. The "no hosting" constraint is what makes this not worth pursuing.

The user's framing — "we want to only load what we need when we need it" — is correct as a principle and is what MosaicLayer already attempts at the viewport-tile level. The bottleneck is that "need" at z3 over CONUS = "1095 sources, one tiny overview tile each" because that's literally the data's shape. The pyramid is doing its job *within* each COG; it's the sharding tax that hurts.

## Cecil.earth investigation

User asked if `docs.cecil.earth/datasets/84f5bd` was free. Verdict:

- The **dataset** has "no data acquisition cost" — that's about USDA's publishing policy, not Cecil's pricing.
- **Cecil is a contract-billed access layer.** Their language ("one contract, one integration, no minimum usage requirements", visible Billing section, Contact Us workflow) is enterprise sales, not free tier.
- The dataset Cecil is wrapping is **USDA's 2024 10m Cropland Data Layer** — a brand-new product (CDL went from 30m → 10m starting with 2024 data).
- The 10m CDL is available **directly from USDA** for free (next section). Cecil's value-add is the unified API across many datasets, not the data itself.

## USDA 10m CDL — what's actually accessible

URL: `https://www.nass.usda.gov/Research_and_Science/Cropland/Release/datasets/2024_10m_cdls.zip`

Verified via HEAD + Range probe:
- 9.0 GB zip, served via Azure App Gateway
- `accept-ranges: bytes`, `HTTP/2 206` on 16-byte range request → confirmed Range-readable
- No auth, public domain

Zip central directory (read via Range from byte ~SIZE-4KB):
- `2024_10m_cdls.tif` (main GeoTIFF)
- `2024_10m_cdls.tif.ovr` ← **external overview file, not embedded**
- `2024_10m_cdls.tfw` (world file)
- FGDC + ISO metadata files

**The `.ovr` sidecar is the dealbreaker for direct browser consumption.** The GeoTIFF inside the zip uses external overviews (the older GDAL pattern) rather than the COG layout (overviews embedded in the same file as IFDs the spec walks). `async-geotiff` and most browser-side COG readers won't follow a sidecar `.ovr`. So even if you wrote a zip-over-HTTP reader (feasible — `unzipit` / `client-zip` Range-read the central directory then individual entries), browsing the .tif would only give you full-res 10m at every zoom level → way slower than what we have at 30m with pyramid.

To use 10m in the current app architecture you'd need to:
1. Download the 9 GB zip once.
2. `gdal_translate` to a real COG with internal overviews (or shard into per-tile COGs the way MPC does for 30m).
3. Host on R2/B2 (~$2/mo, free egress on R2).

This is "hosting derived data" — the prior session's constraint that we've been honoring. With Cloudflare R2 making it ~free and zero-ops, the constraint may not be as binding as it was. Open question for next session if 10m matters.

**No STAC mirror of 10m CDL exists yet.** MPC's `usda-cdl` collection tops out at 2021/30m. No third party has rehosted the 10m product as sharded COGs that we know of. May change as MPC catches up; for now the 9 GB zip is the only addressable form.

## State of main at end of session

```
a07d776 stats: weight tile contributions by viewport bbox overlap fraction
eae9a1c trim repo to just the browser app
5e20261 web: category filter, year badge, Voyager basemap, repo README
18ac2d9 web: viewport-strict crops dashboard, labels-over-raster, collapsible panel
11dfe5c web: click-to-inspect picking on the CDL mosaic
48bf6c8 web: CONUS default viewport, handle pixel-interleaved CDL tiles
6e437bc web: move dev server to port 5454 (avoid 3000 collisions)
7e2b8b2 web: scaffold deck.gl-raster browser app for CDL mosaic
```

Pushed through `eae9a1c`. `a07d776` (the bbox-overlap stats weighting) is committed locally but not pushed.

## Open follow-ups for next session (browser-app only — notebooks dropped)

1. **Push `a07d776`** to origin if not already.
2. **Decide on the 10m question.** If "yes, want 2024 10m in the app", do the R2 mirror dance (~3 hours). Otherwise stick with MPC 30m 2021 and move on.
3. **GitHub Pages deploy.** Still blocked by 1hr SAS TTL. The clean answer is runtime signing with the concurrency limiter I built and ripped out — would need to bring it back, gated to production-build only.
4. **Lift r8uint + PaletteColormap from deck.gl-raster land-cover example.** Cleaner than the current r8unorm-with-scale-to-index approach. ~150 LOC port. Marginal perf but more correct.
5. **Per-pixel viewport clipping in stats.** Current granularity is per-tile-weighted-by-overlap-fraction. For survey-grade acreage we'd need per-pixel clipping. Not asked for; mention if user wants exact numbers.

---

## Late-session add: dev-only auto-regen Vite plugin

User asked for "uv auto, but triggered by browser use, not on idle." Built `web/vite-plugin-regen-stac.ts`. How it works:

1. Plugin registers a Vite dev-server middleware on `/regen-stac`.
2. On request: stats `src/minimal_stac.json`. If younger than 50 min → returns `{status:"fresh", ageSeconds}` immediately, does nothing. If older → spawns `uv run scripts/gen_stac.py`, waits up to 60s, returns `{status:"regenerated", took, bytes}`.
3. Coalesces concurrent triggers from multiple tabs into one regen via `inFlight` module-level promise.
4. `App.tsx` fires `fetch("/regen-stac")` once on mount in a `useEffect`. Failures are swallowed silently (so prod builds where the endpoint doesn't exist don't error).
5. When the script writes the new JSON, Vite's file watcher HMRs it into the running app — fresh signed hrefs in seconds, no manual command.

Verified: stale file (mtime backdated) → regen takes ~7s → fresh tokens. Fresh file → instant no-op.

Caveat (known, deferred): first paint after a stale regen has a 1-7s window where `MosaicLayer` is still trying with the OLD imported JSON before HMR ships the new one. Tiles 403 then self-heal. Acceptable for dev; would need to gate layer construction on the regen response for a polished experience.

### TODOs that emerged from this work (deferred to next session)

1. **Prod equivalent.** This plugin is dev-only (registered with `apply: "serve"`). For a deployed app, the options are still: (a) runtime SAS signing with concurrency limiter (built once, reverted), (b) GitHub Action cron that commits/deploys the regenerated JSON daily (broken between regens because SAS is 1hr), or (c) some serverless function (Worker, Lambda) that runs the regen on demand. None ideal.
2. **Tile-load 403 → auto-trigger regen.** Currently the regen only fires on mount. If a user keeps the tab open past the 1hr expiry, the next pan starts 403'ing. We could intercept getCachedGeoTIFF errors with status==403 and fire `/regen-stac` then. ~10 LOC.
3. **Layer construction gated on regen completion.** Avoid the transient 403 flash on stale regen. Show a "refreshing tokens..." overlay during the regen response. ~30 LOC.
4. **MOVE the gen_stac.py invocation off the request path.** Currently the HTTP request blocks 7s waiting for regen. Could spawn async and return immediately; let HMR drive the actual app update.
