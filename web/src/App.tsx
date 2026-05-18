import {
  COGLayer,
  MosaicLayer,
  type GetTileDataOptions,
} from "@developmentseed/deck.gl-geotiff";
import type {
  RasterModule,
  RenderTileResult,
} from "@developmentseed/deck.gl-raster";
import { CreateTexture } from "@developmentseed/deck.gl-raster/gpu-modules";
import type { Overview } from "@developmentseed/geotiff";
import { GeoTIFF } from "@developmentseed/geotiff";
import { MapboxOverlay } from "@deck.gl/mapbox";
import type { Device, Texture } from "@luma.gl/core";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { Map as MaplibreMap, useControl } from "react-map-gl/maplibre";
import type { MapRef } from "react-map-gl/maplibre";

import { cdlPaletteLookup, createCdlPaletteTexture } from "./cdlShaders";
import { epsgResolver } from "./proj";
import STAC_DATA from "./minimal_stac.json";
import PALETTE_DATA from "./palette.json";

type PartialSTACItem = {
  bbox: [number, number, number, number];
  assets: { image: { href: string } };
};

type STACFeatureCollection = { features: PartialSTACItem[] };

type PaletteData = {
  /** 256 * 4 RGBA bytes, base64-encoded so it survives JSON round-trip. */
  rgbaBase64: string;
  /** class code -> human-readable crop name (for picking later). */
  names: Record<string, string>;
};

type TextureDataT = {
  width: number;
  height: number;
  texture: Texture;
};

// Module-level cache of opened GeoTIFFs, keyed by URL. Same pattern as
// naip-mosaic: header reads are small, GeoTIFF instances are reusable,
// caching them separately from MosaicLayer's TileLayer cache means we can
// drop maxCacheSize without dropping the header metadata.
const geotiffCache = new Map<string, Promise<GeoTIFF>>();

function getCachedGeoTIFF(url: string, signal?: AbortSignal): Promise<GeoTIFF> {
  let p = geotiffCache.get(url);
  if (!p) {
    p = GeoTIFF.fromUrl(url, { signal }).catch((err) => {
      geotiffCache.delete(url);
      throw err;
    });
    geotiffCache.set(url, p);
  }
  return p;
}

/**
 * Read one COG tile as a single-band uint8 GPU texture.
 *
 * CDL is paletted single-band uint8 with no nodata declared. We upload as
 * r8unorm so the shader sees the class code in `color.r` (normalized to
 * [0,1] by the sampler) — the cdlPaletteLookup module unnormalizes and
 * indexes the palette LUT.
 */
async function getTileData(
  image: GeoTIFF | Overview,
  options: GetTileDataOptions,
): Promise<TextureDataT> {
  const { device, x, y, signal } = options;
  const tile = await image.fetchTile(x, y, { signal, boundless: false });
  const { array } = tile;
  const { width, height } = array;

  // CDL is single-band paletted uint8. Either layout collapses to the
  // same flat Uint8Array when count == 1.
  const data =
    array.layout === "band-separate" ? array.bands[0] : array.data;
  if (!(data instanceof Uint8Array)) {
    throw new Error(
      `CDL tile expected Uint8Array, got ${data?.constructor?.name}`,
    );
  }
  if (data.length !== width * height) {
    throw new Error(
      `CDL tile length ${data.length} != ${width}*${height}`,
    );
  }

  const texture = device.createTexture({
    data,
    format: "r8unorm",
    width,
    height,
    sampler: {
      // Class codes must not be interpolated; nearest only.
      minFilter: "nearest",
      magFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    },
  });

  return { texture, width, height };
}

function makeRenderTile(paletteTexture: Texture) {
  return function renderTile(tileData: TextureDataT): RenderTileResult {
    const renderPipeline: RasterModule[] = [
      { module: CreateTexture, props: { textureName: tileData.texture } },
      { module: cdlPaletteLookup, props: { cdlPalette: paletteTexture } },
    ];
    return { renderPipeline };
  };
}

function DeckGLOverlay({
  layers,
  onDeviceInitialized,
}: {
  layers: any[];
  onDeviceInitialized?: (device: Device) => void;
}) {
  const overlay = useControl(
    () =>
      new MapboxOverlay({
        interleaved: true,
        layers,
        onDeviceInitialized,
      } as any),
  );
  overlay.setProps({ layers });
  return null;
}

export default function App() {
  const mapRef = useRef<MapRef>(null);
  const [device, setDevice] = useState<Device | null>(null);
  const [paletteTexture, setPaletteTexture] = useState<Texture | null>(null);

  const stacItems = (STAC_DATA as unknown as STACFeatureCollection).features;
  const palette = PALETTE_DATA as PaletteData;

  // Decode the base64 palette once on mount.
  const paletteRgba = useMemo(() => {
    const bin = atob(palette.rgbaBase64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }, [palette.rgbaBase64]);

  // Upload palette to GPU once a Device exists.
  useEffect(() => {
    if (!device) return;
    setPaletteTexture(createCdlPaletteTexture(device, paletteRgba));
  }, [device, paletteRgba]);

  const renderTile = useMemo(
    () => (paletteTexture ? makeRenderTile(paletteTexture) : null),
    [paletteTexture],
  );

  const layers = useMemo(() => {
    if (!renderTile || stacItems.length === 0) return [];
    const mosaic = new MosaicLayer<PartialSTACItem, GeoTIFF>({
      id: "cdl-mosaic",
      sources: stacItems,
      getSource: (source, { signal }) =>
        getCachedGeoTIFF(source.assets.image.href, signal),
      renderSource: (source, { data, signal }) =>
        new COGLayer<TextureDataT>({
          id: `cdl-cog-${source.assets.image.href}`,
          epsgResolver,
          geotiff: data,
          getTileData,
          renderTile,
          signal,
        }),
      maxCacheSize: 0,
    });
    return [mosaic];
  }, [renderTile, stacItems]);

  // CONUS overview — matches the NLCD-notebook UX. Pan/zoom anywhere from here.
  const initialViewState = {
    longitude: -98.0,
    latitude: 39.5,
    zoom: 3.5,
    pitch: 0,
    bearing: 0,
  };

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <MaplibreMap
        ref={mapRef}
        initialViewState={initialViewState}
        minZoom={2}
        mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
      >
        <DeckGLOverlay layers={layers} onDeviceInitialized={setDevice} />
      </MaplibreMap>
      <div
        style={{
          position: "absolute",
          top: 12,
          left: 12,
          padding: "8px 12px",
          background: "rgba(0,0,0,0.6)",
          color: "white",
          fontSize: 13,
          borderRadius: 4,
        }}
      >
        CDL mosaic — {stacItems.length} items, {Object.keys(palette.names).length} classes
      </div>
    </div>
  );
}
