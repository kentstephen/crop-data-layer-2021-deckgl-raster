# Issue draft for `developmentseed/lonboard`

**Suggested title:** `RasterLayer.from_stac_items` — wrap `MultiRasterTilesetDescriptor` for sharded STAC raster collections

---

## Body

`RasterLayer` today has two constructors — `from_geotiff` for a single COG, and `from_pmtiles` for a single PMTiles archive. Neither fits the common pattern of a STAC collection whose data is sharded across many small COGs (e.g. MPC's `naip`, `usda-cdl`, `usgs-3dep-seamless`, most planet-scale collections). Each individual item works fine via `from_geotiff`, but there's no single-layer way to mosaic across items with viewport-driven byte-range fan-out.

`deck.gl-raster` already has the machinery: `MultiRasterTilesetDescriptor`, `resolveSecondaryTiles`, `createMultiRasterTilesetDescriptor` in `packages/deck.gl-raster/src/multi-raster-tileset/`. The [`naip-mosaic`](https://github.com/developmentseed/deck.gl-raster/tree/main/examples/naip-mosaic) example demonstrates the pattern in JavaScript against MPC's NAIP collection — pre-generated minimal STAC JSON (`{bbox, href}` per item) → `MultiRasterTileset`-backed layer → browser fans out per-viewport-tile reads.

Proposed Python surface, mirroring the shape of the existing constructors:

```python
layer = RasterLayer.from_stac_items(
    items,                       # list of dicts: [{"bbox": [...], "assets": {"image": {"href": "..."}}}, ...]
    asset_key="image",           # which STAC asset to use
    store=AzureStore(...),       # obstore, for SAS signing / auth
    path_from_href=lambda h: ..., # extract object path from asset href (mirrors lazycogs)
    render_tile=render_callback,  # same RenderTile[T] protocol as from_geotiff
    pickable=True,
)
```

The Python side is a thin adapter over the existing `from_geotiff` widget-bridge pattern; the heavy lifting stays in JS. This is what unblocks rendering arbitrarily-large sharded STAC raster collections in lonboard with NLCD-equivalent UX (CONUS visible at low zoom, smooth pan/zoom, pickable per-pixel via the user's `render_tile`).

Happy to provide a verbose reproducer / motivating use case (USDA Cropland Data Layer on MPC) if useful.
