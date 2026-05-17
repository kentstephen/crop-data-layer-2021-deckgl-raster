# CDL + lazycogs + Planetary Computer — Debug Report

Branch: `cdl-lazycogs-mosaic`
Notebook: `cdl-lazycogs-mosaic.ipynb`
Date: 2026-05-17

## Goal

Render USDA Cropland Data Layer (CDL) for arbitrary CONUS regions in Lonboard, using the all-Rust DevSeed stack — `obstore` + `async-geotiff` + `lazycogs` + `rustac` — with data served from Microsoft Planetary Computer's `usda-cdl` collection. No tile server, no GDAL.

## Stack confirmed working

| Component | Status | Evidence |
|---|---|---|
| `pystac-client` / `rustac.search_to` | ✅ | 35 items for Iowa, 1095 for CONUS land in `cdl_items.parquet` |
| `obstore.AzureStore` + `PlanetaryComputerCredentialProvider` | ✅ | `head_async` returns metadata, `get_range_async` returns valid TIFF magic bytes |
| `async_geotiff.GeoTIFF.open` against the same store | ✅ | Reads one CDL tile, returns `uint8` array with real classes (Corn=1, Soybeans=5, Pasture=176, etc.) |
| `lazycogs.open` returning a structured DataArray | ✅ | Correct shape, coords, CRS, transform |
| `lazycogs` materialization (`.values`) | ⚠️ Two bugs found, one remaining |

## Bugs found

### Bug 1 — SHOWSTOPPER, FIXED — DuckDB timezone shift

**Symptom:** `.values` returned an all-zero `float32` array. Lonboard showed an opaque black rectangle (because GEE's CDL colormap maps class 0 to `#000000` opaque; that's a separate cosmetic issue fixed by overriding `cmap_array[0] = (0, 0, 0, 0)`).

**Root cause:** CDL items have `start_datetime = "2021-01-01T00:00:00+00:00"` and no plain `datetime` field. When DuckDB (via `rustac`) reads this through pyarrow, the timestamp is converted to system local time. In any negative-UTC zone (e.g. `America/New_York`), `2021-01-01T00:00:00+00:00` becomes `2020-12-31T19:00:00-05:00`. `lazycogs._build_time_steps` then slices `iso[:10]` and gets `"2020-12-31"`, which it uses as both the xarray time coord AND the per-chunk DuckDB re-query filter. The per-chunk query for items dated exactly `2020-12-31` matches zero rows, so every chunk produces nodata.

**Diagnostic evidence:**
```
lazycogs._backend DEBUG  duckdb_client.search bands=['cropland'] date=2020-12-31 returned 0 items in 0.003s
```
Confirmed by direct pyarrow inspection:
```
start_datetime col: datetime.datetime(2020, 12, 31, 19, 0, tzinfo=zoneinfo.ZoneInfo(key='America/New_York'))
```

**Fix (in notebook, top of `imports` cell):**
```python
import os
os.environ["TZ"] = "UTC"
import time
time.tzset()
# ...then import rustac/lazycogs/etc.
```

After the fix:
```
lazycogs._backend DEBUG  duckdb_client.search bands=['cropland'] date=2021-01-01/2021-12-31 returned 35 items in 0.007s
raw stats: min=0.0 max=195.0 nan_pct=0.0%
```

Real CDL classes appear in the output: `[0, 1, 5, 12, 111, 121, 143, 176, 190, 195]`.

### Bug 2 — FIXED (workaround in notebook; upstream fix pending) — Only first item populates pixels

**Symptom:** With Bug 1 fixed, ~0.8% of the Iowa output is non-zero. The non-zero pixels are confined to rows 0–7 of a 160×330 output (latitudes 43.45°–43.59°, longitudes -95.07° to -93.97°) — a thin horizontal sliver matching the bbox of the FIRST item returned (`cropland_2021_73905_2362575_90000`, bbox `[-95.08, 43.43, -93.94, 44.25]`).

**Confirmed not the cause:**
- Items returned by the parquet DO cover Iowa: lat centers 40.50°–43.85°, lon centers -96.77° to -90.03°
- `read_chunk_async` log line confirms `35 items, 330x160 px` were processed in 0.565s
- The first item's data IS being reprojected to the correct destination location

**Root cause (verified via source read):** `lazycogs/_mosaic_methods.py:27-31` — `FirstMethod.is_done` returns `True` when the running mosaic has no masked pixels. CDL COGs declare `nodata=None`, so `_array_to_masked(arr, effective_nodata=None)` produces a fully-unmasked array. After the first item is processed, the running mosaic has its real footprint filled (e.g. top 8 rows of Iowa) and the rest filled with the destination's initial fill value (0) — but the mask is all-False, so `is_done` returns True and `_chunk_reader._drain_in_order` (line 505) cancels all pending tasks for the remaining 34 items.

The `lazycogs` example notebooks don't hit this because Sentinel-2 scenes have real nodata at scene edges, so the first item's mask is genuinely non-trivial. CDL tiles are edge-to-edge with no declared nodata, which is the unusual case.

**Workaround:** pass `nodata=0` to `lazycogs.open()`. This sets `effective_nodata=0` so `_array_to_masked` masks the destination-fill zeros. After item 1, only its real footprint is unmasked → `is_done=False` → items 2–N process. Also conveniently aliases CDL's class 0 ("Background") to transparent in the render, which is what we want.

**Verification (Iowa, 160×330 px, after both workarounds):**
```
duckdb_client.search ... date=2021-01-01/2021-12-31 returned 35 items
read_chunk_async ... (35 items, 330x160 px) took 0.819s
shape=(160, 330)  nonzero=52800 (100.0%)  unique=[1 4 5 12 13 21 23 24 26 27 28 36 37 42 53 59 61 111 121 122 123 124 131 141 142 143 176 190 195 225]
nz row range: 0–159 of 160   nz col range: 0–329 of 330
```

**Verification (CONUS, 1275×2925 px):**
```
duckdb_client.search ... returned 1095 items
read_chunk_async ... (1095 items, 2925x1275 px) took 60.174s
shape=(1275, 2925)  nonzero=2027615 (54.4%)  unique=[0 1 2 3 4 5 6 10 11 12 13 14 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38]
nz row range: 6–1128 of 1275   nz col range: 14–2924 of 2925
```
54.4% is correct — the bbox includes Pacific + Atlantic + Gulf + Mexico + Canada, all genuinely outside CDL coverage.

## What worked along the way

- **Diagnostic ladder**: tested store auth → direct async-geotiff read → lazycogs DataArray construction → lazycogs materialize, in that order. Pinned each layer cleanly. Worth keeping these diagnostic cells in the notebook permanently.
- **Local `uv` env** (deps in `pyproject.toml`) + `jupyter nbconvert --execute --inplace` for non-interactive iteration. Far faster than `uvx juv run` + manual cell execution + copy-pasting output from JupyterLab.
- **lazycogs DEBUG logging** (`logging.getLogger("lazycogs").setLevel(logging.DEBUG)`) — the per-chunk `duckdb_client.search ... returned N items` line is the single most useful diagnostic. It pinned Bug 1 instantly.

## Two notebooks, two branches

| Branch | Notebook | Approach | Status |
|---|---|---|---|
| `cdl-lonboard-raster-layer` | `raster-cog-cdl-pc.ipynb` | One MPC tile, `RasterLayer.from_geotiff` interactive, deck.gl-raster reprojects in WebGL shader | Not validated end-to-end yet but mirrors the working NLCD example structure |
| `cdl-lazycogs-mosaic` | `cdl-lazycogs-mosaic.ipynb` | Many MPC tiles, `lazycogs.open` mosaic + reproject server-side (pyproj+numpy), `BitmapLayer` | Partially working: Bug 1 fixed, Bug 2 outstanding |

## Recommendations

1. **File the TZ bug upstream against `lazycogs`.** Reproducer is trivial — any STAC parquet whose items have only `start_datetime` at a UTC-midnight boundary. Fix on their end is to do timezone-aware date extraction or set DuckDB's session TZ to UTC.

2. **Bug 2 needs upstream investigation or a workaround.** Possible workarounds to try before continuing:
   - Pass `mosaic_method=lazycogs.HighestMethod` or another non-FirstMethod to see if mosaic behavior changes
   - Pass explicit `chunks={"y": 256, "x": 256}` to force smaller chunks (each chunk processes fewer items, may dodge the bug)
   - Open one item directly with `lazycogs.open(..., ids=[item_id])` and confirm a single-item case works; then two items; binary search the bug

3. **The companion notebook (`raster-cog-cdl-pc.ipynb`) is likely the lower-risk path** if the goal is "render CDL in Lonboard fast." It uses `RasterLayer.from_geotiff` + a single MPC tile and lets deck.gl-raster handle the Albers → Mercator reprojection in the browser shader. No `lazycogs` involved. The trade-off: one tile at a time, not mosaiced. For a UI that pans across CDL, you'd build multiple `RasterLayer`s, one per intersecting MPC item, rather than one big mosaic.

4. **Keep the diagnostic cells.** The HEAD probe, the direct `async-geotiff` read, the per-chunk lazycogs DEBUG log, and the spatial nonzero-pixel range printout collectively make this notebook self-diagnosing. Don't strip them in any "cleanup" pass.

## Open questions for the user

- Do you want me to (a) keep digging on Bug 2, (b) file it upstream and pivot to the `RasterLayer` path, or (c) park the lazycogs branch and just ship the single-tile interactive version?
- Is the goal CONUS at a glance (static raster, lazycogs path) or pan-and-zoom interactive (tiled, RasterLayer path)? They're genuinely different products.
