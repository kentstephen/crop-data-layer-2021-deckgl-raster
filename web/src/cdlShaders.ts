import type { Device, Texture } from "@luma.gl/core";
import type { ShaderModule } from "@luma.gl/shadertools";

/**
 * Integer-aware CDL render pipeline, ported from the `land-cover` example
 * in `developmentseed/deck.gl-raster` (May 2026).
 *
 * Three small modules, wired in this order per tile:
 *
 *   1. CreateTextureUint   — sample the r8uint tile -> `ivec4 icolor`
 *   2. FilterCategory      — texelFetch into a 256-entry boolean LUT,
 *                            discard if the class isn't selected
 *   3. PaletteColormap     — texelFetch into a 256-entry RGBA colormap,
 *                            discard alpha=0 (Background + nodata)
 *
 * Everything uses `texelFetch` so the sampler filter is irrelevant to
 * correctness — no risk of bilinear blending producing nonsense class
 * codes between adjacent paletted pixels.
 */

/** ----- 1. CreateTextureUint ---------------------------------------- */

export type CreateTextureUintProps = {
  /** Source `r8uint` tile texture. */
  textureName: Texture;
};

export const CreateTextureUint = {
  name: "create-texture-uint",
  inject: {
    "fs:#decl": `uniform highp usampler2D textureName;`,
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      ivec4 icolor = ivec4(texture(textureName, geometry.uv));
    `,
  },
  getUniforms: (props: Partial<CreateTextureUintProps> = {}) => ({
    textureName: props.textureName,
  }),
} as const satisfies ShaderModule<CreateTextureUintProps>;

/** ----- 2. FilterCategory ------------------------------------------- */

export type FilterCategoryProps = {
  /**
   * 256x1 `r8unorm` lookup texture: byte 255 at every selected class code,
   * 0 elsewhere. Sampled with `texelFetch` so sampler filter is moot.
   */
  categoryFilterLUT: Texture;
};

export const FilterCategory = {
  name: "filter-category",
  inject: {
    "fs:#decl": `uniform sampler2D categoryFilterLUT;`,
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      if (texelFetch(categoryFilterLUT, ivec2(icolor.r, 0), 0).r < 0.5) {
        discard;
      }
    `,
  },
  getUniforms: (props: Partial<FilterCategoryProps> = {}) => ({
    categoryFilterLUT: props.categoryFilterLUT,
  }),
} as const satisfies ShaderModule<FilterCategoryProps>;

/** ----- 3. PaletteColormap ------------------------------------------ */

export type PaletteColormapProps = {
  /** 256x1 `rgba8unorm` colormap. Alpha=0 entries render as transparent. */
  colormapTexture: Texture;
};

export const PaletteColormap = {
  name: "palette-colormap",
  inject: {
    "fs:#decl": `uniform sampler2D colormapTexture;`,
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      color = texelFetch(colormapTexture, ivec2(icolor.r, 0), 0);
      if (color.a == 0.0) {
        discard;
      }
    `,
  },
  getUniforms: (props: Partial<PaletteColormapProps> = {}) => ({
    colormapTexture: props.colormapTexture,
  }),
} as const satisfies ShaderModule<PaletteColormapProps>;

/** ----- Texture builders -------------------------------------------- */

/**
 * Build the 256x1 RGBA colormap texture from the GEE-derived palette.
 * `paletteRgba` is a flat Uint8Array of length 1024 (256 * 4).
 *
 * Built once at startup. The category filter no longer mutates this.
 */
export function createCdlColormapTexture(
  device: Device,
  paletteRgba: Uint8Array,
): Texture {
  if (paletteRgba.length !== 256 * 4) {
    throw new Error(
      `CDL palette must be 256 * 4 = 1024 bytes, got ${paletteRgba.length}`,
    );
  }
  return device.createTexture({
    data: paletteRgba,
    format: "rgba8unorm",
    width: 256,
    height: 1,
    sampler: {
      minFilter: "nearest",
      magFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    },
  });
}

/**
 * Build a 256-entry boolean LUT (255 at selected codes, 0 elsewhere) and
 * upload as a 256x1 r8unorm texture. Cheap to re-create on every filter
 * change — that's the whole point of the integer pipeline.
 */
export function createCdlFilterLUTTexture(
  device: Device,
  activeCodes: Set<number>,
): Texture {
  const lut = new Uint8Array(256);
  for (const code of activeCodes) {
    if (code >= 0 && code <= 255) lut[code] = 255;
  }
  return device.createTexture({
    data: lut,
    format: "r8unorm",
    width: 256,
    height: 1,
    sampler: {
      minFilter: "nearest",
      magFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    },
  });
}
