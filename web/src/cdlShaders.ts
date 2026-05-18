import type { Device, Texture } from "@luma.gl/core";
import type { ShaderModule } from "@luma.gl/shadertools";

/**
 * CDL palette lookup shader module.
 *
 * Sits *after* a CreateTexture step in the render pipeline. The upstream
 * texture is an r8unorm single-band image whose value is the CDL class code
 * normalized to [0,1] by the texture sampler (class 0 -> 0.0, class 255 -> 1.0).
 *
 * We sample a 256x1 RGBA palette texture using the class index, snap to texel
 * centers so we get exact class colors (no interpolation between adjacent
 * classes — corn != soybean blend), discard pixels with alpha 0 (CDL class 0
 * "Background"), and write the result into `color`.
 *
 * Critical assumption: the upstream texture is r8unorm and CreateTexture
 * emits `color = vec4(r, 0, 0, 1)`. If CreateTexture turns out to require
 * rgba8unorm in deck.gl-raster 0.7, we'll need our own create-texture variant.
 */
export const cdlPaletteLookup = {
  name: "cdl-palette-lookup",
  fs: /* glsl */ `
    uniform sampler2D cdlPalette;
  `,
  inject: {
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      float idx = color.r;
      // Snap to texel center to avoid bilinear interpolation across classes.
      vec2 lookup = vec2(idx * (255.0 / 256.0) + (0.5 / 256.0), 0.5);
      vec4 mapped = texture(cdlPalette, lookup);
      if (mapped.a < 0.5) discard;
      color = mapped;
    `,
  },
  getUniforms: (props: { cdlPalette?: Texture } = {}) => ({
    cdlPalette: props.cdlPalette,
  }),
} as const satisfies ShaderModule<{ cdlPalette: Texture }>;

/**
 * Build the 256x1 RGBA palette texture from the GEE-derived palette array.
 * `paletteRgba` is a flat Uint8Array of length 1024 (256 * 4).
 */
export function createCdlPaletteTexture(
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
