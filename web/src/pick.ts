import type { GeoTIFF } from "@developmentseed/geotiff";
import proj4 from "proj4";

/**
 * Click-to-inspect for the CDL mosaic.
 *
 * Picking through deck.gl's normal channel would only give us the rendered
 * RGB color of a pixel — useless because we'd have to reverse-lookup the
 * palette, and any non-1:1 zoom would have applied filtering anyway.
 *
 * Instead we do an out-of-band per-pixel read:
 *   1. find which source COG's bbox contains (lng, lat)
 *   2. transform lon/lat -> EPSG:5070 Albers (CDL's native CRS)
 *   3. geotiff.index() -> full-res (row, col)
 *   4. derive the internal (tx, ty) tile and local (row, col) within it
 *   5. fetch that tile (usually warm in deck.gl-raster's tile cache)
 *   6. read one byte -> CDL class code -> palette.names[code]
 */

// Register EPSG:5070 (NAD83 / Conus Albers) so proj4 can transform lon/lat into it.
proj4.defs(
  "EPSG:5070",
  "+proj=aea +lat_0=23 +lon_0=-96 +lat_1=29.5 +lat_2=45.5 " +
    "+x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs +type=crs",
);
const lonLatToAlbers = proj4("EPSG:4326", "EPSG:5070");

export type PartialSTACItem = {
  bbox: [number, number, number, number];
  assets: { image: { href: string } };
};

export type PickResult = {
  lng: number;
  lat: number;
  classCode: number;
  cropName: string;
  sourceHref: string;
};

/**
 * Linear scan to find the source whose bbox contains (lng, lat). CDL tiles
 * are non-overlapping in the grid sense; if more than one bbox loosely
 * contains a point on a shared edge the first wins — same pixel either way.
 */
export function findSource(
  items: PartialSTACItem[],
  lng: number,
  lat: number,
): PartialSTACItem | null {
  for (const it of items) {
    const [w, s, e, n] = it.bbox;
    if (lng >= w && lng <= e && lat >= s && lat <= n) return it;
  }
  return null;
}

export async function readPixel(
  geotiff: GeoTIFF,
  lng: number,
  lat: number,
  names: Record<string, string>,
  sourceHref: string,
): Promise<PickResult | null> {
  const [x, y] = lonLatToAlbers.forward([lng, lat]);
  let [row, col] = geotiff.index(x, y);

  const { width: tileW, height: tileH } = geotiff.image.tileSize;
  const { x: tileCountX, y: tileCountY } = geotiff.image.tileCount;
  const imgW = tileCountX * tileW;
  const imgH = tileCountY * tileH;

  // Clicks on the very south/east bbox edge return row == imgH or col == imgW
  // exactly; clamp into the last pixel so we don't overshoot the tile count.
  if (row < 0 || col < 0 || row >= imgH || col >= imgW) {
    // Click was outside the COG's pixel grid even though inside its bbox
    // (can happen on tiles padded with empty rows). Clamp; if it's way off,
    // bail to null.
    if (row < -1 || col < -1 || row > imgH || col > imgW) return null;
    row = Math.max(0, Math.min(row, imgH - 1));
    col = Math.max(0, Math.min(col, imgW - 1));
  }

  const tx = Math.floor(col / tileW);
  const ty = Math.floor(row / tileH);
  const localCol = col - tx * tileW;
  const localRow = row - ty * tileH;

  const tile = await geotiff.fetchTile(tx, ty, { boundless: false });
  const { array } = tile;
  const data =
    array.layout === "band-separate" ? array.bands[0] : array.data;
  if (!(data instanceof Uint8Array)) return null;

  const idx = localRow * array.width + localCol;
  if (idx < 0 || idx >= data.length) return null;
  const code = data[idx];
  return {
    lng,
    lat,
    classCode: code,
    cropName: names[String(code)] ?? `Class ${code}`,
    sourceHref,
  };
}
