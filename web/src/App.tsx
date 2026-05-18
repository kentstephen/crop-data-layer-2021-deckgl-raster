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
import {
  CATEGORIES,
  allDisplayCodes,
  otherCategoryCodes,
  type Category,
} from "./categories";
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

type STACFeatureCollection = {
  features: PartialSTACItem[];
  /** Crop year baked in by gen_stac.py; older JSONs may omit it. */
  year?: number;
};

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
  // Codes the user wants rendered/counted. Default: all displayable codes.
  const [activeCodes, setActiveCodes] = useState<Set<number>>(
    () => new Set(allDisplayCodes(PALETTE_DATA.names)),
  );

  const stacFc = STAC_DATA as unknown as STACFeatureCollection;
  const stacItems = stacFc.features;
  const stacYear = stacFc.year ?? null;
  const palette = PALETTE_DATA as PaletteData;

  // Decode the base64 palette once on mount.
  const paletteRgba = useMemo(() => {
    const bin = atob(palette.rgbaBase64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }, [palette.rgbaBase64]);

  // Apply category-filter selection: copy the base palette but zero the
  // alpha byte for any class not in activeCodes. The shader discards
  // alpha=0, so filtered-out classes vanish from the map. No shader
  // change required; we just re-upload this LUT on filter changes.
  const filteredPaletteRgba = useMemo(() => {
    const out = new Uint8Array(paletteRgba);
    for (let code = 1; code < 256; code++) {
      if (!activeCodes.has(code)) out[code * 4 + 3] = 0;
    }
    return out;
  }, [paletteRgba, activeCodes]);

  // Upload (and re-upload on filter change). Destroy the previous texture
  // so we don't leak GPU memory across edits.
  useEffect(() => {
    if (!device) return;
    const tex = createCdlPaletteTexture(device, filteredPaletteRgba);
    setPaletteTexture(tex);
    return () => {
      tex.destroy?.();
    };
  }, [device, filteredPaletteRgba]);

  // Subscribe to stats updates (fires after each tile gets recorded).
  useEffect(() => {
    setUpdateListener(() => setStatsTick((n) => n + 1));
    return () => setUpdateListener(null);
  }, []);

  // Dev-only: on mount, ask the dev server to regenerate minimal_stac.json
  // if it's stale (SAS tokens expire ~1hr). Vite's file watcher will HMR
  // the fresh JSON in. No-op in prod builds where the endpoint 404s.
  useEffect(() => {
    fetch("/regen-stac")
      .then((r) => (r.ok ? r.json() : null))
      .then((res) => {
        if (res?.status === "regenerated") {
          // eslint-disable-next-line no-console
          console.info(
            `[regen-stac] refreshed (${res.took}ms${res.bytes ? `, ${res.bytes}B` : ""})`,
          );
        }
      })
      .catch(() => {
        // dev plugin not present (prod build) — fall through silently
      });
  }, []);

  // Compute viewport-aware crop stats. Recomputes when the viewport bbox
  // changes (user pans/zooms) OR new tile data lands (statsTick bumps).
  // Filter to only the categories the user has active.
  const cropStats: CropStat[] = useMemo(() => {
    if (!viewportBbox) return [];
    return aggregateInViewport(viewportBbox)
      .filter((s) => activeCodes.has(s.classCode))
      .slice(0, 20);
    // statsTick intentionally in deps to invalidate on new tile data
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewportBbox, statsTick, activeCodes]);

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
        mapStyle="https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json"
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
        year={stacYear}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((c) => !c)}
        activeCodes={activeCodes}
        onActiveCodesChange={setActiveCodes}
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
  year,
  collapsed,
  onToggleCollapsed,
  activeCodes,
  onActiveCodesChange,
}: {
  stats: CropStat[];
  paletteRgba: Uint8Array;
  names: Record<string, string>;
  sourceCount: number;
  classCount: number;
  year: number | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  activeCodes: Set<number>;
  onActiveCodesChange: (s: Set<number>) => void;
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
          {year != null && (
            <span style={{
              marginLeft: 8,
              fontSize: 11,
              fontWeight: 500,
              padding: "2px 6px",
              background: "rgba(255,255,255,0.12)",
              borderRadius: 3,
              verticalAlign: "middle",
            }}>
              {year}
            </span>
          )}
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
          : `${fmt.format(totalAcres)} acres · ${fmt.format(totalPixels)} px · ${stats.length} class${stats.length === 1 ? "" : "es"}`}
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
                <td style={{ padding: "5px 4px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 110 }}>
                  {names[String(row.classCode)] ?? `Class ${row.classCode}`}
                </td>
                <td style={{ padding: "5px 4px", textAlign: "right", opacity: 0.85, fontVariantNumeric: "tabular-nums" }}>
                  {fmt.format(row.areaAcres)} ac
                </td>
                <td style={{ padding: "5px 4px", textAlign: "right", opacity: 0.6, fontVariantNumeric: "tabular-nums", fontSize: 11 }}>
                  {fmt.format(row.pixelCount)} px
                </td>
                <td style={{ padding: "5px 0 5px 4px", textAlign: "right", opacity: 0.55, fontVariantNumeric: "tabular-nums", width: 36 }}>
                  {pct.toFixed(1)}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{
        opacity: 0.45,
        fontSize: 10,
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        marginTop: 8,
        padding: "6px 8px",
        background: "rgba(255,255,255,0.04)",
        borderRadius: 4,
        lineHeight: 1.4,
      }}>
        acres = pixels × pixel_area_m² × 0.000247
        <br />
        pixel_area_m² from EPSG:5070 affine transform
      </div>

      <CategoryFilter
        activeCodes={activeCodes}
        onActiveCodesChange={onActiveCodesChange}
        names={names}
      />
        </>
      )}
    </div>
  );
}

function CategoryFilter({
  activeCodes,
  onActiveCodesChange,
  names,
}: {
  activeCodes: Set<number>;
  onActiveCodesChange: (s: Set<number>) => void;
  names: Record<string, string>;
}) {
  const allCodes = useMemo(() => allDisplayCodes(names), [names]);
  const otherCodes = useMemo(() => otherCategoryCodes(names), [names]);

  const setCategory = (codes: number[], on: boolean) => {
    const next = new Set(activeCodes);
    for (const c of codes) {
      if (on) next.add(c);
      else next.delete(c);
    }
    onActiveCodesChange(next);
  };

  const isCategoryOn = (codes: number[]) =>
    codes.some((c) => activeCodes.has(c));
  const isCategoryFullyOn = (codes: number[]) =>
    codes.every((c) => activeCodes.has(c));

  const rows: Array<Category | { id: "other"; label: string; codes: number[] }> = [
    ...CATEGORIES,
    { id: "other", label: "Other / fallow / no-data", codes: otherCodes },
  ];

  return (
    <div style={{ marginTop: 14, borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div style={{ fontWeight: 600, fontSize: 12 }}>Categories</div>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            type="button"
            onClick={() => onActiveCodesChange(new Set(allCodes))}
            style={chipBtnStyle}
          >
            Show all
          </button>
          <button
            type="button"
            onClick={() => onActiveCodesChange(new Set())}
            style={chipBtnStyle}
          >
            Hide all
          </button>
        </div>
      </div>
      {rows.map((cat) => {
        if (cat.codes.length === 0) return null;
        const on = isCategoryOn(cat.codes);
        const full = isCategoryFullyOn(cat.codes);
        return (
          <label
            key={cat.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "4px 0",
              fontSize: 12,
              cursor: "pointer",
              opacity: on ? 1 : 0.55,
            }}
          >
            <input
              type="checkbox"
              checked={full}
              ref={(el) => {
                if (el) el.indeterminate = on && !full;
              }}
              onChange={(e) => setCategory(cat.codes, e.target.checked)}
              style={{ accentColor: "#7cc4ff" }}
            />
            <span style={{ flex: 1 }}>{cat.label}</span>
            <span style={{ opacity: 0.45, fontSize: 10 }}>{cat.codes.length}</span>
          </label>
        );
      })}
    </div>
  );
}

const chipBtnStyle: React.CSSProperties = {
  appearance: "none",
  background: "rgba(255,255,255,0.08)",
  color: "white",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 3,
  padding: "3px 8px",
  fontSize: 10,
  cursor: "pointer",
  textTransform: "uppercase",
  letterSpacing: 0.4,
};
