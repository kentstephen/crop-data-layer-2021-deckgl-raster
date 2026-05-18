# Next steps — handoff

## The goal (unchanged across the whole session)

Recreate the `raster-cog-nlcd-server.ipynb` experience but for **USDA Cropland Data Layer (CDL)** instead of NLCD. Specifically:

- Single Python layer object → drop it on a `Map`
- CONUS visible at low zoom
- Smooth zoom-in / zoom-out (overviews fetched on demand)
- Pan refetches tiles for the new viewport
- Pickable per-pixel: hover returns a CDL class code → map to crop name via `crop_names` dict
- Fast load and interaction
- Uses the DevSeed stack (`obstore` + `async-geotiff` + `lonboard`)

## Why this hasn't shipped yet (the honest version)

NLCD works because **DevSeed publishes one national NLCD COG with a full overview pyramid** on a public S3 bucket. `RasterLayer.from_geotiff(geotiff)` takes one file and that's the whole notebook.

CDL on Microsoft Planetary Computer is **sharded into ~1000 small per-tile COGs**. There's no spanning overview, so `from_geotiff` doesn't fit. The browser-side machinery to handle exactly this (`MosaicLayer` / `MultiRasterTilesetDescriptor`) **exists in `deck.gl-raster`** and is demonstrated in the [`naip-mosaic` example](https://github.com/developmentseed/deck.gl-raster/tree/main/examples/naip-mosaic). **lonboard hasn't wrapped it into a Python `from_stac_items` or `from_mosaic` constructor yet.**

Constraints the user has stated:
- No hosting (no PMTiles bucket, no own S3, no GitHub releases of derived data)
- No local downloads of USDA's zipped national TIFFs
- No third-party private mirrors (Fused's `s3://fused-asset/...` is out)

These constraints rule out every "make the data look like one COG" workaround. The only remaining vector is to close the wrapper gap in lonboard itself.

## The current state of the lonboard / deck.gl-raster ecosystem (verified 2026-05-17)

Recent activity that matters:

- **`lonboard` PR #1183 (merged 2026-04-29)**: "Use upstream deck.gl-raster `RasterTileLayer`" — lonboard now consumes `RasterTileLayer` directly from `deck.gl-raster`. This is the foundational integration step. https://github.com/developmentseed/lonboard/pull/1183
- **`lonboard` PR #1179 (open, draft)**: "wip: Start brainstorming zarr integration" — designs `RasterLayer.from_zarr` and `RasterLayer.from_xarray`, **adds a "generic `TilesetDescriptor` trait" to the JS-side raster model**. Same shape of wrapper we'd want for STAC mosaic. https://github.com/developmentseed/lonboard/pull/1179
- **`deck.gl-raster` actively polishing `MosaicLayer`**: issue #555 (request scheduler hookup), recent merges renaming/hardening `MosaicSource` / `MosaicTileset2D` APIs (#533, #550, #551), `naip-mosaic` example being refined (#554).
- **No public issue at `developmentseed/lonboard` requesting `RasterLayer.from_stac_items` or equivalent.** Verified via `gh search`. The prerequisites only just landed; the ask hasn't been made yet.

## Two paths forward — pick one before iterating

### Path A — File the upstream issue, ship best-achievable today

One short issue at `developmentseed/lonboard` asking for `RasterLayer.from_stac_items(items, store, path_from_href, render_tile)`. Cite PR #1179's "generic `TilesetDescriptor` trait" language so it slots into the design conversation that's actively happening.

**Issue draft already exists** at `.claude/memory/from_stac_items_issue.md`. Review and post via `gh issue create --repo developmentseed/lonboard --title "..." --body-file .claude/memory/from_stac_items_issue.md`.

While waiting:
- `cdl-stac-mosaic.ipynb` on `cdl-mosaic-prep` already renders via multi-RasterLayer for bbox-scoped CDL and has the one-line swap commented in for when `from_stac_items` lands.
- All the data shapes are right (NAIP-pattern minimal STAC JSON, GEE colormap LUT, `crop_names` for picking).

Cost: low (file one issue). Wait time: out of our control. Could be days, could be never.

### Path B — Build the wrapper ourselves in this repo

**Not yet verified to be feasible.** Before committing to this path, need to confirm:

1. **Does lonboard expose an extension surface?** Specifically: can a project-local anywidget subclass talk to a JS-side `MosaicLayer` from `deck.gl-raster` without forking lonboard? Inspect:
   - `lonboard/_base.py` and `lonboard/layer/_base.py` for `BaseLayer` / `BaseArrowLayer` extension points
   - How `RasterLayer` itself bridges Python → JS (anywidget esm/css traits, message protocol)
   - Whether `lonboard.experimental` has user-extensible widget primitives

2. **What's the JS-side bundling story?** If we need to ship a custom JS bundle that imports from `@developmentseed/deck.gl-raster`, can we do that as a notebook-local widget, or do we need a published npm package?

3. **Is the MosaicLayer JS API stable enough?** `MosaicTileset2D` was just made private (#550), `MosaicSource` was renamed (#551). If the API is still churning, building against it now means rework when it stabilizes.

If all three questions are tractable: build a `CDLMosaicLayer` widget that wraps deck.gl-raster's `MosaicLayer`, feed it the NAIP-pattern STAC JSON, ship the NLCD UX for CDL today.

Cost: substantial — Python + JS + bundling. Time: hours to days depending on the answers to (1) and (2). Result: doesn't require waiting on upstream.

### Recommendation

Spend **10–15 minutes** verifying questions (1) and (2) under Path B before deciding. Concretely:
- Read `lonboard/layer/_raster.py` and `lonboard/_base.py` end to end
- Look at any community-built lonboard widget extensions (search GitHub for "import lonboard" + "AnywidgetBase" or similar)
- Check anywidget docs for project-local widget bundling pattern

If those answers come back "anywidget bundling is straightforward + lonboard has an extension hook" → Path B, build it.
If those answers come back "you'd be forking lonboard or shipping a separate package" → Path A, file the issue, ship Path A's deliverables.

## Current repo state (branches and notebooks)

Branches pushed to https://github.com/kentstephen/cdl-lonboard-05-2026:

| Branch | Notebook | What it does |
|---|---|---|
| `main` | `raster-cog-nlcd-server.ipynb` | The original NLCD reference. The target shape. |
| `cdl-lonboard-raster-layer` | `raster-cog-cdl-pc.ipynb` | Single MPC CDL tile via `RasterLayer.from_geotiff`. Interactive, pickable, but only one ~90 km region. |
| `cdl-lazycogs-mosaic` | `cdl-lazycogs-mosaic.ipynb` | CONUS-static via `lazycogs` → `BitmapLayer`. Covers everything but doesn't refetch on zoom, not pickable. Exposed two real `lazycogs` bugs (TZ + FirstMethod), both worked around with documented one-liners. |
| `cdl-multi-rasterlayer` | `cdl-multi-rasterlayer.ipynb` | N × `RasterLayer.from_geotiff` per STAC item. Interactive + pickable but caps at ~50 layers (state-scale). Also contains aborted `deprecated/cdl-mpc-tiles.ipynb`. |
| `cdl-mosaic-prep` | `cdl-stac-mosaic.ipynb` + `deprecated/cdl-mpc-tiles.ipynb` | Pre-generates NAIP-pattern minimal STAC JSON; renders today via multi-RasterLayer; includes commented one-line swap for `from_stac_items` when it lands. **Most current.** |

Local artifacts (gitignored):
- `.claude/memory/MEMORY.md` — verbose session retrospective
- `.claude/memory/from_stac_items_issue.md` — ready-to-post issue draft

## What to do next session

1. Decide Path A vs Path B (use the 10–15 min verification above).
2. If Path A: review `.claude/memory/from_stac_items_issue.md`, post via `gh`, link the URL in `MEMORY.md`, stop.
3. If Path B: scope the wrapper build (probably new branch `cdl-mosaiclayer-wrapper`), start with the smallest possible "instantiate `MosaicLayer` from Python and see something render" proof of concept.
4. Either way: clean up the deprecated folder. Several notebooks are scope-limited but not actually broken; pick which ones are canonical and demote the rest.

## What NOT to do next session

- Rebuild any of the existing four notebooks from scratch. They cover the achievable scope.
- Try more "different angles" on the data sourcing — every public source has been verified. There is no single public CDL COG with overviews. Stop looking.
- Re-attempt `cdl-mpc-tiles.ipynb` (the BitmapTileLayer + MPC mosaic URL path). It either gives up per-class picking (server-rendered) or bypasses the stack (raw HTTP), and neither matches the goal.
- Use `BitmapLayer` as a "CONUS overview" — it's structurally static, not zoom-aware. `lazycogs` notebook already covers that use case.
