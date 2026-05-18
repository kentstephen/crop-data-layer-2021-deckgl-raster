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
import {
  Map as MaplibreMap,
  useControl,
  type MapLayerMouseEvent,
} from "react-map-gl/maplibre";
import type { MapRef } from "react-map-gl/maplibre";

import { cdlPaletteLookup, createCdlPaletteTexture } from "./cdlShaders";
import { findSource, readPixel, type PickResult } from "./pick";
import { epsgResolver } from "./proj";
import {
  aggregateInViewport,
  recordTile,
  setUpdateListener,
  type CropStat,
} from "./stats";
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
/**
 * Per-source getTileData factory: closes over the source href so we can
 * attribute each tile's histogram back to its source in stats.ts.
 */
function makeGetTileData(sourceHref: string) {
  return async function getTileData(
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

    // Cheap: count class codes for the viewport-aware crop dashboard.
    recordTile(image, sourceHref, x, y, data);

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
  };
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
  const [pick, setPick] = useState<PickResult | null>(null);
  const [picking, setPicking] = useState(false);
  const [viewportBbox, setViewportBbox] = useState<
    [number, number, number, number] | null
  >(null);
  const [statsTick, setStatsTick] = useState(0);
  const [labelBeforeId, setLabelBeforeId] = useState<string | undefined>(undefined);
  const [collapsed, setCollapsed] = useState(false);

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

  // Subscribe to stats updates (fires after each tile gets recorded).
  useEffect(() => {
    setUpdateListener(() => setStatsTick((n) => n + 1));
    return () => setUpdateListener(null);
  }, []);

  // Compute viewport-aware crop stats. Recomputes when the viewport bbox
  // changes (user pans/zooms) OR new tile data lands (statsTick bumps).
  const cropStats: CropStat[] = useMemo(() => {
    if (!viewportBbox) return [];
    return aggregateInViewport(viewportBbox).slice(0, 12);
    // statsTick intentionally in deps to invalidate on new tile data
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewportBbox, statsTick]);

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
          getTileData: makeGetTileData(source.assets.image.href),
          renderTile,
          signal,
        }),
      maxCacheSize: 0,
      // Render the raster BELOW basemap labels so place names and borders
      // stay legible. beforeId comes from inspecting the live style's layer
      // list (first symbol layer) — set in onLoad below.
      // @ts-expect-error beforeId is injected by @deck.gl/mapbox; LayerProps
      // doesn't know about it.
      beforeId: labelBeforeId,
    });
    return [mosaic];
  }, [renderTile, stacItems, labelBeforeId]);

  // CONUS overview — matches the NLCD-notebook UX. Pan/zoom anywhere from here.
  const initialViewState = {
    longitude: -98.0,
    latitude: 39.5,
    zoom: 3.5,
    pitch: 0,
    bearing: 0,
  };

  const onMapClick = async (e: MapLayerMouseEvent) => {
    const { lng, lat } = e.lngLat;
    const source = findSource(stacItems, lng, lat);
    if (!source) {
      setPick(null);
      return;
    }
    setPicking(true);
    try {
      // Reuse the same cache the layer uses, so a clicked pixel inside a
      // visible tile is a free read.
      const gt = await getCachedGeoTIFF(source.assets.image.href);
      const result = await readPixel(
        gt,
        lng,
        lat,
        palette.names,
        source.assets.image.href,
      );
      setPick(result);
    } catch (err) {
      console.error("pick failed:", err);
      setPick(null);
    } finally {
      setPicking(false);
    }
  };

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <MaplibreMap
        ref={mapRef}
        initialViewState={initialViewState}
        minZoom={2}
        onClick={onMapClick}
        cursor={picking ? "wait" : "crosshair"}
        mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
        onLoad={(e) => {
          const map = e.target;
          const b = map.getBounds();
          setViewportBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
          // Find the first symbol (label) layer in whatever style is loaded,
          // so deck.gl renders underneath it. Falls back to undefined (deck
          // on top) if there are no symbol layers, which is fine.
          const layers = map.getStyle()?.layers ?? [];
          const firstSymbol = layers.find((l: any) => l.type === "symbol");
          if (firstSymbol) setLabelBeforeId(firstSymbol.id);
        }}
        onMoveEnd={(e) => {
          const b = e.target.getBounds();
          setViewportBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
        }}
      >
        <DeckGLOverlay layers={layers} onDeviceInitialized={setDevice} />
      </MaplibreMap>
      <CropDashboard
        stats={cropStats}
        paletteRgba={paletteRgba}
        names={palette.names}
        sourceCount={stacItems.length}
        classCount={Object.keys(palette.names).length}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((c) => !c)}
      />

      {pick && (
        <div
          style={{
            position: "absolute",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            padding: "10px 16px",
            background: "rgba(0,0,0,0.8)",
            color: "white",
            borderRadius: 6,
            pointerEvents: "none",
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 600 }}>{pick.cropName}</div>
          <div style={{ opacity: 0.7, fontSize: 12, marginTop: 4 }}>
            class {pick.classCode} · {pick.lng.toFixed(4)}, {pick.lat.toFixed(4)}
          </div>
        </div>
      )}
    </div>
  );
}

function CropDashboard({
  stats,
  paletteRgba,
  names,
  sourceCount,
  classCount,
  collapsed,
  onToggleCollapsed,
}: {
  stats: CropStat[];
  paletteRgba: Uint8Array;
  names: Record<string, string>;
  sourceCount: number;
  classCount: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const totalPixels = stats.reduce((s, r) => s + r.pixelCount, 0);
  const totalAcres = stats.reduce((s, r) => s + r.areaAcres, 0);
  const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        left: 12,
        width: collapsed ? "auto" : 320,
        maxHeight: "calc(100% - 24px)",
        overflowY: "auto",
        padding: collapsed ? "8px 12px" : "14px 16px",
        background: "rgba(0,0,0,0.78)",
        color: "white",
        fontSize: 12,
        borderRadius: 6,
        boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
      }}
    >
      <div
        onClick={onToggleCollapsed}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          cursor: "pointer",
          userSelect: "none",
          gap: 12,
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          USDA Cropland Data Layer
        </div>
        <span style={{ opacity: 0.6, fontSize: 12 }}>
          {collapsed ? "▸" : "▾"}
        </span>
      </div>

      {collapsed ? null : (
        <>
      <div style={{ opacity: 0.65, fontSize: 11, marginTop: 4, marginBottom: 10 }}>
        {sourceCount} source COGs · {classCount} classes · click any pixel to inspect
      </div>

      <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 2 }}>
        Crops in viewport
      </div>
      <div style={{ opacity: 0.65, fontSize: 11, marginBottom: 8 }}>
        {stats.length === 0
          ? "loading tiles…"
          : `${fmt.format(totalAcres)} acres · ${stats.length} class${stats.length === 1 ? "" : "es"}`}
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          {stats.map((row) => {
            const i = row.classCode * 4;
            const r = paletteRgba[i];
            const g = paletteRgba[i + 1];
            const b = paletteRgba[i + 2];
            const pct = (row.pixelCount / totalPixels) * 100;
            return (
              <tr key={row.classCode} style={{ borderTop: "1px solid rgba(255,255,255,0.07)" }}>
                <td style={{ padding: "5px 4px 5px 0", width: 14 }}>
                  <span
                    style={{
                      display: "inline-block",
                      width: 12,
                      height: 12,
                      background: `rgb(${r},${g},${b})`,
                      border: "1px solid rgba(255,255,255,0.25)",
                      borderRadius: 2,
                    }}
                  />
                </td>
                <td style={{ padding: "5px 4px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 140 }}>
                  {names[String(row.classCode)] ?? `Class ${row.classCode}`}
                </td>
                <td style={{ padding: "5px 4px", textAlign: "right", opacity: 0.85, fontVariantNumeric: "tabular-nums" }}>
                  {fmt.format(row.areaAcres)} ac
                </td>
                <td style={{ padding: "5px 0 5px 4px", textAlign: "right", opacity: 0.55, fontVariantNumeric: "tabular-nums", width: 36 }}>
                  {pct.toFixed(1)}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
        </>
      )}
    </div>
  );
}
