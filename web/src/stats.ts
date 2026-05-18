import type { GeoTIFF, Overview } from "@developmentseed/geotiff";

import { albersToLonLat } from "./proj";

/**
 * Viewport-strict crop histograms.
 *
 * Hook getTileData -> count pixels per class for every uploaded tile.
 * Record each tile's bbox in lon/lat (derived from its affine transform
 * in EPSG:5070, then projected). At aggregate time, only tiles whose bbox
 * intersects the current viewport bbox contribute.
 *
 * That's still "any tile that overlaps the viewport contributes all of
 * its pixels" — i.e. edge tiles whose bbox is half outside the viewport
 * still count their entire content. For exact per-pixel clipping we'd
 * have to walk every pixel; for "what crops dominate this view" the tile
 * granularity is plenty.
 *
 * Per-source overview-level keying: when a tile lands at a different
 * pixel area than what we'd previously stored for that source, we drop
 * the older overview's tiles so the same ground area isn't counted at
 * two different resolutions.
 */

type TileEntry = {
  pixelAreaM2: number;
  /** axis-aligned lon/lat bbox [w, s, e, n] */
  bbox: [number, number, number, number];
  /** length 256 */
  histogram: Uint32Array;
};

type SourceStats = {
  pixelAreaM2: number;
  tiles: Map<string, TileEntry>; // key "tx:ty"
};

const sourceStats = new Map<string, SourceStats>();

let onUpdate: (() => void) | null = null;
let updatePending = false;

function scheduleUpdate(): void {
  if (updatePending || !onUpdate) return;
  updatePending = true;
  queueMicrotask(() => {
    updatePending = false;
    onUpdate?.();
  });
}

export function setUpdateListener(fn: (() => void) | null): void {
  onUpdate = fn;
}

function tileBboxLonLat(
  image: GeoTIFF | Overview,
  tx: number,
  ty: number,
  tileW: number,
  tileH: number,
): [number, number, number, number] {
  // Transform 4 tile corners through the COG's affine, then unproject to
  // lon/lat. Use min/max of the 4 corners as an axis-aligned bbox — this
  // slightly overestimates for an Albers-projected tile, which is fine
  // for an intersection test.
  const corners: Array<[number, number]> = [];
  for (const [r, c] of [
    [ty * tileH, tx * tileW],
    [ty * tileH, (tx + 1) * tileW],
    [(ty + 1) * tileH, tx * tileW],
    [(ty + 1) * tileH, (tx + 1) * tileW],
  ] as Array<[number, number]>) {
    const [x, y] = image.xy(r, c);
    const [lng, lat] = albersToLonLat.forward([x, y]);
    corners.push([lng, lat]);
  }
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [lng, lat] of corners) {
    if (lng < w) w = lng;
    if (lng > e) e = lng;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return [w, s, e, n];
}

export function recordTile(
  image: GeoTIFF | Overview,
  sourceHref: string,
  tx: number,
  ty: number,
  data: Uint8Array,
): void {
  const t = image.transform;
  const pixelAreaM2 = Math.abs(t[0]) * Math.abs(t[4]);

  let entry = sourceStats.get(sourceHref);
  if (!entry || entry.pixelAreaM2 !== pixelAreaM2) {
    // Different overview level than what we had cached for this source;
    // drop the prior level's tiles so we don't double-count the same
    // ground area at two resolutions.
    entry = { pixelAreaM2, tiles: new Map() };
    sourceStats.set(sourceHref, entry);
  }

  const { width: tileW, height: tileH } = image.image.tileSize;
  const bbox = tileBboxLonLat(image, tx, ty, tileW, tileH);

  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i]]++;

  entry.tiles.set(`${tx}:${ty}`, { pixelAreaM2, bbox, histogram: hist });
  scheduleUpdate();
}

export type CropStat = {
  classCode: number;
  pixelCount: number;
  areaM2: number;
  areaAcres: number;
};

const ACRES_PER_M2 = 0.000247105;

/**
 * Sum histograms across every recorded tile whose lon/lat bbox intersects
 * the viewport bbox, *weighted by the fraction of each tile's bbox that's
 * actually inside the viewport*.
 *
 * Without the fraction weighting, a 7×7 km tile whose corner just barely
 * pokes into a 1×1 km city-block viewport would contribute its full ~65k
 * pixels — inflating area by 50×. With the weighting, the same tile
 * contributes ~1/49 of its pixels, which is correct under the (mild)
 * assumption that any given class is roughly uniformly distributed
 * within the tile. For homogeneous regions (a square of cornfields)
 * this is essentially exact; in patchy areas it's an approximation
 * but bounded by the tile size.
 *
 * Counts are returned as floating-point — they're now "expected pixels
 * of class C inside the viewport" rather than integer pixel counts.
 */
export function aggregateInViewport(
  viewportBbox: [number, number, number, number],
): CropStat[] {
  const [vw, vs, ve, vn] = viewportBbox;
  const totals = new Map<number, { count: number; areaM2: number }>();

  for (const source of sourceStats.values()) {
    for (const tile of source.tiles.values()) {
      const [w, s, e, n] = tile.bbox;
      // Overlap rectangle in lon/lat degrees.
      const ow = Math.max(w, vw);
      const os = Math.max(s, vs);
      const oe = Math.min(e, ve);
      const on = Math.min(n, vn);
      if (oe <= ow || on <= os) continue;

      const tileArea = (e - w) * (n - s);
      if (tileArea <= 0) continue;
      const frac = ((oe - ow) * (on - os)) / tileArea;

      for (let c = 0; c < 256; c++) {
        const n2 = tile.histogram[c];
        if (n2 === 0) continue;
        const cur = totals.get(c) ?? { count: 0, areaM2: 0 };
        cur.count += n2 * frac;
        cur.areaM2 += n2 * frac * tile.pixelAreaM2;
        totals.set(c, cur);
      }
    }
  }

  return [...totals.entries()]
    .map(([code, { count, areaM2 }]) => ({
      classCode: code,
      pixelCount: count,
      areaM2,
      areaAcres: areaM2 * ACRES_PER_M2,
    }))
    .sort((a, b) => b.pixelCount - a.pixelCount);
}
