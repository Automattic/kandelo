/**
 * CRTC color stage: the legacy gamma LUT (`GAMMA_LUT`) a Linux CRTC applies
 * to its output, after the planes (primary and cursor) are blended.
 *
 * The kernel owns the LUT (`DRM_IOCTL_MODE_SETGAMMA` / the CRTC's
 * `GAMMA_LUT` property) and hands the host 16-bit `drm_color_lut` entries.
 * Every presenter shows 8-bit RGB, so the host reduces each entry to the
 * 8-bit value a CRTC with an 8-bit LUT would emit and applies that table to
 * the blended output. A CRTC whose table maps every value to itself shows
 * exactly what it would without a LUT, so it has no color stage at all.
 */
import type { KmsCursor } from "./cursor-plane.js";

/** The color stage of one CRTC. `version` changes whenever the table does. */
export interface KmsGamma {
  version: number;
  /** 768 bytes: the red, green and blue output for each 8-bit input. */
  table: Uint8Array<ArrayBuffer>;
}

/** `drm_color_lut_extract(value, 8)`: round a 16-bit LUT entry to the
 *  8-bit precision of the output. */
function extract8(value: number): number {
  return Math.min(255, (value + 0x80) >>> 8);
}

/** Reduce the kernel's `entries`-per-channel LUT (red entries, then green,
 *  then blue) to the 8-bit table presenters apply, or null when the table
 *  is the identity (the CRTC output is then exactly its blended planes). */
export function kmsGammaTable(lut: Uint16Array): Uint8Array<ArrayBuffer> | null {
  const entries = lut.length / 3;
  if (entries !== 256) throw new RangeError(`Invalid KMS gamma LUT size ${lut.length}`);
  const table = new Uint8Array(768);
  let identity = true;
  for (let i = 0; i < 768; i++) {
    table[i] = extract8(lut[i]);
    if (table[i] !== (i & 255)) identity = false;
  }
  return identity ? null : table;
}

/** Map the RGB of every RGBA pixel through `table`; alpha is not a color. */
export function applyKmsGamma(rgba: Uint8Array | Uint8ClampedArray, table: Uint8Array): void {
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = table[rgba[i]];
    rgba[i + 1] = table[256 + rgba[i + 1]];
    rgba[i + 2] = table[512 + rgba[i + 2]];
  }
}

/** Blend the cursor plane over the primary's RGBA output the way a CRTC
 *  does before its color stage: premultiplied source-over
 *  (`DRM_MODE_BLEND_PREMULTI`, the legacy cursor's blend mode) at the
 *  cursor's CRTC position. `bottomUp` says the rows are in GL order (row
 *  zero at the bottom of the display). The primary's alpha is unchanged. */
export function compositeKmsCursor(
  rgba: Uint8Array | Uint8ClampedArray, width: number, height: number,
  cursor: KmsCursor, bottomUp = false,
): void {
  const image = cursor.premultiplied;
  if (!image) return;
  for (let row = 0; row < cursor.height; row++) {
    const y = cursor.y + row;
    if (y < 0 || y >= height) continue;
    const line = bottomUp ? height - 1 - y : y;
    for (let column = 0; column < cursor.width; column++) {
      const x = cursor.x + column;
      if (x < 0 || x >= width) continue;
      const source = (row * cursor.width + column) * 4;
      const alpha = image[source + 3];
      if (alpha === 0 && image[source] === 0 && image[source + 1] === 0 && image[source + 2] === 0) continue;
      const target = (line * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        rgba[target + c] = Math.min(255, Math.round(image[source + c] + rgba[target + c] * (255 - alpha) / 255));
      }
    }
  }
}

/** The CRTC output of one primary frame: cursor blended, then the color
 *  stage. Leaves `rgba` untouched when the CRTC has no color stage. */
export function kmsCrtcOutput(
  rgba: Uint8Array | Uint8ClampedArray, width: number, height: number,
  gamma: KmsGamma | null, cursor: KmsCursor | null, bottomUp = false,
): void {
  if (!gamma) return;
  if (cursor) compositeKmsCursor(rgba, width, height, cursor, bottomUp);
  applyKmsGamma(rgba, gamma.table);
}
