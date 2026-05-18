# deprecated/

Notebooks here didn't work or were abandoned mid-flight. Kept for reference only.

## `cdl-mpc-tiles.ipynb`

Attempted to use Microsoft Planetary Computer's mosaic tile API (`/api/data/v1/mosaic/{searchId}/tilejson.json`) with `lonboard.BitmapTileLayer`. Two problems:

1. **HTTP 405 from the tile endpoint** with `"Tile request must contain a collection..."`, even after adding `collection=usda-cdl` to the URL. Never pinned the actual missing parameter.
2. **Architectural** — even if (1) were fixed, this approach imports only `requests` + `BitmapTileLayer` and bypasses the entire DevSeed obstore/async-geotiff/lonboard stack we've been building on. The whole point of the project is to USE that stack end-to-end.

See `.claude/memory/MEMORY.md` for the corrected architecture: the right answer is to expose `MultiRasterTilesetDescriptor` from `deck.gl-raster` in `lonboard` as `RasterLayer.from_stac_items(items)`. That's an upstream feature request, not something we can build in a notebook today.
