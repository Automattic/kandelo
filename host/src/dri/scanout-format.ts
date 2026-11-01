/** Linux DRM fourcc describes byte order in little-endian buffer memory.
 * Both presenters consume the same bounded snapshot; a 2D canvas needs RGBA,
 * while WebGL uploads each format to its own texture and decodes it in its
 * shader (kms-color-stage.ts).
 *
 * Every presenter shows 8 bits per channel, like a monitor connected at
 * 8 bpc. A 10-bit or half-float framebuffer is reduced to 8 bits by
 * rounding to nearest, in exactly the same way on every path (the CPU 2D
 * blit here, the GPU presenters in their shader), so a framebuffer looks
 * the same whichever presenter shows it, and the CRTC's gamma LUT is
 * indexed by the reduced 8-bit value, as an 8-bpc legacy LUT is. */
import { drmFormatInfo } from "../webgl/drm-format-info.js";
import { gpuStorageFormat } from "../webgl/gpu-storage-format.js";

export interface ScanoutGeometry {
  width: number;
  height: number;
  pitch: number;
  pixel_format: number;
}

/** How a texel holds a channel: 8-bit unorm, RGB565 (5/6-bit, expanded by
 *  bit replication), 10-bit unorm (rounded to 8 bits) or a half float
 *  (clamped to [0, 1], NaN as 0, rounded to 8 bits). */
export const ScanoutEncoding = { Unorm8: 0, Rgb565: 1, Unorm10: 2, Float: 3 } as const;
export type ScanoutEncoding = typeof ScanoutEncoding[keyof typeof ScanoutEncoding];

export interface ScanoutFormat {
  bytesPerPixel: 1 | 2 | 4 | 8;
  /** The format holds blue where GL holds red (XRGB/ARGB8888 bytes B,G,R,A;
   *  ARGB2101010 blue in the low bits): the presenter swaps red and blue. */
  bgr: boolean;
  encoding: ScanoutEncoding;
  /** The WebGL texture the scanout presenter uploads the bytes to. */
  gl: { internalFormat: number; format: number; type: number };
}

/** Each scanout format's bytes per pixel and texture storage come from the
 * shared format table (drm-format-info.ts, gpu-storage-format.ts); this
 * adds only how the presenter decodes a texel. */
export function scanoutFormat(fourcc: number): ScanoutFormat {
  const { Unorm8, Rgb565, Unorm10, Float } = ScanoutEncoding;
  const info = drmFormatInfo(fourcc), storage = gpuStorageFormat(fourcc);
  if (!info || !storage || !SCANOUT.has(fourcc >>> 0)) throw new RangeError(`Unsupported KMS scanout format ${fourcc}`);
  const encoding = storage.internalFormat === 0x8d62 ? Rgb565 : storage.internalFormat === 0x8059 ? Unorm10
    : storage.internalFormat === 0x881a ? Float : Unorm8;
  return { bytesPerPixel: info.cpp[0] as ScanoutFormat["bytesPerPixel"], bgr: BGR.has(fourcc >>> 0), encoding,
    gl: { internalFormat: storage.internalFormat, format: storage.format, type: storage.type } };
}

/** The primary plane's formats (kms::PRIMARY_PLANE_FORMATS). */
const SCANOUT = new Set([0x34325258, 0x34325241, 0x34324258, 0x34324241, 0x36314752, 0x20203852, 0x38385247,
  0x30335258, 0x30335241, 0x30334258, 0x30334241, 0x48344258, 0x48344241]);
/** Formats holding blue where GL holds red: XRGB/ARGB8888 bytes B,G,R,X/A;
 * X/ARGB2101010 blue in bits 0-9, red in 20-29. */
const BGR = new Set([0x34325258, 0x34325241, 0x30335258, 0x30335241]);

/** A 10-bit channel at 8 bits: round(v * 255 / 1023), as integers. No value
 *  is a tie (v * 510 + 1023 is odd), so no tie-breaking rule is needed. */
export function reduce10(value: number): number {
  return Math.floor((value * 510 + 1023) / 2046);
}

/** A half-float channel at 8 bits: the [0, 1] range an 8-bpc output
 *  carries (NaN as 0), rounded to nearest with ties up, as the presenter
 *  shader's floor(x * 255 + 0.5) does. */
export function reduceHalf(bits: number): number {
  const exponent = (bits >>> 10) & 31, mantissa = bits & 1023, sign = bits & 0x8000 ? -1 : 1;
  return reduceFloat(exponent === 31 ? (mantissa ? NaN : sign * Infinity)
    : sign * (exponent === 0 ? mantissa * 2 ** -24 : (1 + mantissa / 1024) * 2 ** (exponent - 15)));
}

/** reduceHalf of a half's value read back as a float. */
export function reduceFloat(value: number): number {
  return Number.isNaN(value) ? 0 : Math.floor(Math.min(Math.max(value, 0), 1) * 255 + 0.5);
}

/** Copy only complete visible rows while the kernel entry owns the source.
 * Padding is not a pixel, and no view into guest memory may reach a presenter. */
export function snapshotScanout(fb: ScanoutGeometry, source: Uint8Array): Uint8Array<ArrayBuffer> {
  const { bytesPerPixel } = scanoutFormat(fb.pixel_format);
  const { width, height, pitch } = fb;
  const rowBytes = width * bytesPerPixel;
  const length = rowBytes * height;
  const sourceLength = pitch * (height - 1) + rowBytes;
  if (![width, height, pitch, rowBytes, length, sourceLength].every(Number.isSafeInteger)
      || width <= 0 || height <= 0 || pitch < rowBytes || sourceLength > source.byteLength) {
    throw new RangeError(`Invalid KMS scanout geometry ${width}x${height} pitch=${pitch}`);
  }
  const packed = new Uint8Array(length);
  for (let y = 0; y < height; y++) {
    packed.set(source.subarray(y * pitch, y * pitch + rowBytes), y * rowBytes);
  }
  return packed;
}

/** Legacy primary scanout is opaque; alpha belongs to the separate cursor.
 * RGB565 expands each endpoint exactly to the corresponding 8-bit endpoint;
 * R8 and GR88 show their channels with the channels they lack zero; 10-bit
 * and half-float channels are reduced to 8 bits (reduce10, reduceHalf). */
export function scanoutRgba(fourcc: number, packed: Uint8Array): Uint8Array<ArrayBuffer> {
  const { bytesPerPixel, bgr, encoding } = scanoutFormat(fourcc);
  const rgb565 = encoding === ScanoutEncoding.Rgb565;
  if (packed.byteLength % bytesPerPixel) throw new RangeError("Incomplete KMS scanout pixel");
  const rgba = new Uint8Array(packed.byteLength / bytesPerPixel * 4);
  for (let source = 0, target = 0; source < packed.byteLength; source += bytesPerPixel, target += 4) {
    if (encoding === ScanoutEncoding.Unorm10) {
      const word = (packed[source] | packed[source + 1] << 8 | packed[source + 2] << 16 | packed[source + 3] << 24) >>> 0;
      const low = reduce10(word & 1023), mid = reduce10((word >>> 10) & 1023), high = reduce10((word >>> 20) & 1023);
      rgba[target] = bgr ? high : low;
      rgba[target + 1] = mid;
      rgba[target + 2] = bgr ? low : high;
    } else if (encoding === ScanoutEncoding.Float) {
      for (let c = 0; c < 3; c++) rgba[target + c] = reduceHalf(packed[source + c * 2] | packed[source + c * 2 + 1] << 8);
    } else if (bytesPerPixel === 1) {
      rgba[target] = packed[source];
    } else if (!rgb565 && bytesPerPixel === 2) {
      rgba[target] = packed[source];
      rgba[target + 1] = packed[source + 1];
    } else if (rgb565) {
      const word = packed[source] | (packed[source + 1] << 8);
      const r = word >>> 11, g = (word >>> 5) & 63, b = word & 31;
      rgba[target] = (r << 3) | (r >>> 2);
      rgba[target + 1] = (g << 2) | (g >>> 4);
      rgba[target + 2] = (b << 3) | (b >>> 2);
    } else {
      rgba[target] = packed[source + (bgr ? 2 : 0)];
      rgba[target + 1] = packed[source + 1];
      rgba[target + 2] = packed[source + (bgr ? 0 : 2)];
    }
    rgba[target + 3] = 255;
  }
  return rgba;
}
