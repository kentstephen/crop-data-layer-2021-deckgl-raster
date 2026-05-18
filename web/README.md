# CDL Client-side Mosaic (deck.gl-raster)

Browser-side rendering of USDA Cropland Data Layer from Microsoft Planetary
Computer, using DevSeed's `MosaicLayer` + `COGLayer` from
`@developmentseed/deck.gl-geotiff`. No tile server, no derived data, no
hosting — the browser opens each per-tile COG over HTTP Range and the
mosaic engine fans out byte-range reads per visible map tile.

This is the path the Python notebooks can't take today because lonboard
hasn't wrapped `MosaicLayer` into a `RasterLayer.from_stac_items` Python
constructor. See `../NEXT.md` and `.claude/memory/MEMORY.md` for the full
backstory.

## Architecture

Mirrors `developmentseed/deck.gl-raster/examples/naip-mosaic` with three
adaptations for CDL:

| Concern | NAIP example | CDL (this app) |
|---|---|---|
| CRS | UTM zones 10–20 | EPSG:5070 Albers CONUS — see `proj.ts` |
| Texture format | `rgba8unorm` (4-band) | `r8unorm` (single-band paletted) |
| Render pipeline | `CreateTexture` → optional NDVI | `CreateTexture` → `cdlPaletteLookup` |
| Palette | NDVI colormap sprite | 256-entry RGBA LUT from GEE catalog |
| Picking | none | TODO (v2) — see below |

The custom `cdlPaletteLookup` shader module (`src/cdlShaders.ts`) samples
the r8unorm class-code texture, unnormalizes the value to a [0, 255] index,
looks up a 256x1 RGBA palette texture with nearest filtering (no
interpolation between adjacent classes), and discards pixels with alpha 0
(CDL class 0 "Background").

## Run

```bash
cd web
pnpm install        # or npm install

# Regenerate data (CDL STAC items + palette LUT)
uv run scripts/gen_palette.py     # once; only refresh if GEE updates
uv run scripts/gen_stac.py        # re-run when SAS tokens expire (~1hr)

pnpm dev            # http://localhost:5454
```

To pick a different region/year:

```bash
uv run scripts/gen_stac.py --bbox -120 32 -114 42 --year 2023
```

Default bbox is Iowa (~35 tiles). CONUS (~1095 tiles) works in principle;
expect a slower first viewport while header reads warm up the `geotiffCache`.

## What's working / what isn't (honest)

- ✅ Vite/React/maplibre + `MapboxOverlay` skeleton
- ✅ STAC + palette pre-generation scripts
- ✅ EPSG:5070 reprojection (deck.gl-raster handles in-shader)
- ⚠️ Custom paletted shader — written but **untested in browser**. Most likely
  thing to need iteration. Two things to check first if pixels don't appear:
  - `CreateTexture` from `@developmentseed/deck.gl-raster/gpu-modules` may
    assume RGBA input. If so, write a small variant that does the
    `texture()` call directly and skip CreateTexture.
  - r8unorm sampler returns `vec4(r, 0, 0, 1)`; verify the value is in
    `color.r` and not somewhere else in the pipeline.
- ❌ Picking: not wired. The whole point of CDL-on-lonboard is per-class
  picking (`hover -> "Soybeans"`). The render pipeline outputs colorized
  RGBA, which loses the class code. To restore it:
  - On hover (`onHover` on the layer), get the cursor lon/lat
  - Walk the `stacItems` array to find which source COG covers that point
  - Re-fetch that COG from `geotiffCache` and call `fetchTile` for the
    smallest internal tile covering the point
  - Read the one pixel out of `tile.array.data`, look up
    `palette.names[String(code)]`
  - Render an overlay with the crop name
  - This is ~50–100 lines. Deliberately deferred — `MosaicLayer` v0.7 is
    the riskier piece to verify works at all.

## Known footguns (from prior session — see ../.claude/memory/MEMORY.md)

- **SAS token TTL ~1hr.** `src/minimal_stac.json` is gitignored for this
  reason. Symptom of expiry: 403s in the network tab. Fix: re-run `gen_stac.py`.
- **CDL has no declared nodata.** Class 0 is the implicit "background"; the
  shader treats palette alpha 0 as discard. Don't set a nodata to a real
  class code.
- **Class codes must not be filtered.** Both the COG texture and the
  palette texture use nearest filtering. Bilinear blending between corn (1)
  and cotton (2) would produce class 1.5 = garbage.
- **MPC tile server route (`/api/data/v1/mosaic/...`) is not used.** That
  was the dead end from the previous session — it returns server-rendered
  RGB and bypasses the stack we care about.
