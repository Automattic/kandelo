/**
 * Exact byte conversion between a CPU-tier dma-buf plane of a DRM format and
 * the WebGL 2 texture that mirrors it (cpu-image-storage.ts). The mirror is a
 * texture of the format's own internal format (gpu-storage-format.ts), so
 * rendering into it has the format's precision and channels, and both
 * directions are lossless:
 *
 * - upload: the plane's bytes become the texture's texels unchanged, apart
 *   from a channel-order swap (ARGB vs ABGR) and a padding channel (X…),
 *   which uploads as alpha 1.0;
 * - publication: a readback in a format/type WebGL 2 accepts for that
 *   storage returns every stored value exactly (RGBA bytes for 8-bit and
 *   RGB565 storage, from which round(v * max / 255) recovers each 5/6-bit
 *   value; packed 2_10_10_10_REV words for RGB10_A2; float32 for RGBA16F,
 *   which converts back to the same half), and a padding channel keeps the
 *   plane's own bits.
 */
import { gpuStorageFormat, type GpuStorageFormat } from "./gpu-storage-format.js";
import { drmFormatInfo } from "./drm-format-info.js";

export type CpuImageReadback = Uint8Array<ArrayBuffer> | Uint32Array<ArrayBuffer> | Float32Array<ArrayBuffer>;

export interface CpuImageCodec {
  /** Bytes per pixel of the plane. */
  cpp: number;
  storage: GpuStorageFormat;
  /** The publication readback's readPixels format and type. */
  readFormat: number;
  readType: number;
  /** A readback buffer for `pixels` texels. */
  readback(pixels: number): CpuImageReadback;
  /** The `width` x `height` texels at `offset`/`pitch` of `bytes`, packed for
   *  texSubImage2D with the storage's format and type. */
  pack(bytes: Uint8Array, offset: number, pitch: number, width: number, height: number): ArrayBufferView;
  /** Write texel `index` of `readback` as plane bytes at `out[at]`; a padding
   *  channel is copied from `previous[at]` (the bytes last uploaded). */
  encode(readback: CpuImageReadback, index: number, previous: Uint8Array, out: Uint8Array, at: number): void;
  /** Rendering wrote an alpha other than 1.0 into a format without alpha
   *  (the native alpha lock failed to hold); the mirror must re-upload. */
  alphaWritten(readback: CpuImageReadback, index: number): boolean;
}

const RGBA = 0x1908, UNSIGNED_BYTE = 0x1401, PACKED_2_10_10_10 = 0x8368, FLOAT = 0x1406;
const byteReadback = (pixels: number) => new Uint8Array(pixels * 4);

const scratch = new DataView(new ArrayBuffer(4));
/** IEEE binary16 bits of `value`, rounding to nearest even; exact for every
 *  value a half represents. */
export function halfBits(value: number): number {
  scratch.setFloat32(0, value, true);
  const x = scratch.getUint32(0, true);
  const sign = (x >>> 16) & 0x8000, exponent = (x >>> 23) & 0xff, mantissa = x & 0x7fffff;
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x200 | (mantissa >>> 13) : 0);
  const e = exponent - 112;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    const full = mantissa | 0x800000, shift = 14 - e;
    let h = full >>> shift;
    const rest = full & ((1 << shift) - 1), half = 1 << (shift - 1);
    if (rest > half || (rest === half && (h & 1))) h++;
    return sign | h;
  }
  let h = (e << 10) | (mantissa >>> 13);
  const rest = mantissa & 0x1fff;
  if (rest > 0x1000 || (rest === 0x1000 && (h & 1))) h++;
  return sign | h;
}

function rgba8(bgr: boolean, opaque: boolean, storage: GpuStorageFormat): CpuImageCodec {
  const red = bgr ? 2 : 0, blue = bgr ? 0 : 2;
  return {
    cpp: 4, storage, readFormat: RGBA, readType: UNSIGNED_BYTE, readback: byteReadback,
    pack(bytes, offset, pitch, width, height) {
      const pixels = new Uint8Array(width * height * 4);
      for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
        const src = offset + row * pitch + col * 4, dst = (row * width + col) * 4;
        pixels[dst] = bytes[src + red]; pixels[dst + 1] = bytes[src + 1];
        pixels[dst + 2] = bytes[src + blue]; pixels[dst + 3] = opaque ? 255 : bytes[src + 3];
      }
      return pixels;
    },
    encode(readback, index, previous, out, at) {
      const texel = index * 4;
      out[at + red] = readback[texel]; out[at + 1] = readback[texel + 1]; out[at + blue] = readback[texel + 2];
      out[at + 3] = opaque ? previous[at + 3] : readback[texel + 3];
    },
    alphaWritten: (readback, index) => opaque && readback[index * 4 + 3] !== 255,
  };
}

function unorm8(channels: 1 | 2, storage: GpuStorageFormat): CpuImageCodec {
  return {
    cpp: channels, storage, readFormat: RGBA, readType: UNSIGNED_BYTE, readback: byteReadback,
    pack(bytes, offset, pitch, width, height) {
      const pixels = new Uint8Array(width * height * channels);
      for (let row = 0; row < height; row++)
        pixels.set(bytes.subarray(offset + row * pitch, offset + row * pitch + width * channels), row * width * channels);
      return pixels;
    },
    encode(readback, index, _previous, out, at) {
      for (let c = 0; c < channels; c++) out[at + c] = readback[index * 4 + c];
    },
    alphaWritten: () => false,
  };
}

function rgb565(storage: GpuStorageFormat): CpuImageCodec {
  return {
    cpp: 2, storage, readFormat: RGBA, readType: UNSIGNED_BYTE, readback: byteReadback,
    pack(bytes, offset, pitch, width, height) {
      const pixels = new Uint16Array(width * height);
      for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
        const src = offset + row * pitch + col * 2;
        pixels[row * width + col] = bytes[src] | (bytes[src + 1] << 8);
      }
      return pixels;
    },
    encode(readback, index, _previous, out, at) {
      const texel = index * 4;
      const word = (Math.round(readback[texel] * 31 / 255) << 11)
        | (Math.round(readback[texel + 1] * 63 / 255) << 5) | Math.round(readback[texel + 2] * 31 / 255);
      out[at] = word & 255; out[at + 1] = word >>> 8;
    },
    alphaWritten: () => false,
  };
}

/** ARGB2101010 holds blue in the low ten bits; GL's 2_10_10_10_REV red. */
const swapRedBlue = (word: number) =>
  ((word & 0xc00ffc00) | ((word >>> 20) & 0x3ff) | ((word & 0x3ff) << 20)) >>> 0;

function rgb10a2(bgr: boolean, opaque: boolean, storage: GpuStorageFormat): CpuImageCodec {
  return {
    cpp: 4, storage, readFormat: RGBA, readType: PACKED_2_10_10_10,
    readback: pixels => new Uint32Array(pixels),
    pack(bytes, offset, pitch, width, height) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const pixels = new Uint32Array(width * height);
      for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
        let word = view.getUint32(offset + row * pitch + col * 4, true);
        if (bgr) word = swapRedBlue(word);
        pixels[row * width + col] = opaque ? (word | 0xc0000000) >>> 0 : word;
      }
      return pixels;
    },
    encode(readback, index, previous, out, at) {
      let word = readback[index];
      if (bgr) word = swapRedBlue(word);
      if (opaque) word = ((word & 0x3fffffff) | (previous[at + 3] & 0xc0) << 24) >>> 0;
      out[at] = word & 255; out[at + 1] = (word >>> 8) & 255;
      out[at + 2] = (word >>> 16) & 255; out[at + 3] = word >>> 24;
    },
    alphaWritten: (readback, index) => opaque && readback[index] >>> 30 !== 3,
  };
}

function rgba16f(opaque: boolean, storage: GpuStorageFormat): CpuImageCodec {
  return {
    cpp: 8, storage, readFormat: RGBA, readType: FLOAT,
    readback: pixels => new Float32Array(pixels * 4),
    pack(bytes, offset, pitch, width, height) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const pixels = new Uint16Array(width * height * 4);
      for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
        const src = offset + row * pitch + col * 8, dst = (row * width + col) * 4;
        for (let c = 0; c < 4; c++) pixels[dst + c] = view.getUint16(src + c * 2, true);
        if (opaque) pixels[dst + 3] = 0x3c00;
      }
      return pixels;
    },
    encode(readback, index, previous, out, at) {
      for (let c = 0; c < 4; c++) {
        if (opaque && c === 3) { out[at + 6] = previous[at + 6]; out[at + 7] = previous[at + 7]; continue; }
        const half = halfBits(readback[index * 4 + c]);
        out[at + c * 2] = half & 255; out[at + c * 2 + 1] = half >>> 8;
      }
    },
    alphaWritten: (readback, index) => opaque && readback[index * 4 + 3] !== 1,
  };
}

/** The codec for a CPU-tier plane of `fourcc`, or null when no texture
 *  mirrors that format exactly. */
export function cpuImageCodec(fourcc: number): CpuImageCodec | null {
  const storage = gpuStorageFormat(fourcc);
  if (!storage) return null;
  const codec = formatCodec(fourcc, storage);
  // Each codec's plane size is the shared table's (drm-format-info.ts).
  if (codec && codec.cpp !== drmFormatInfo(fourcc)!.cpp[0]) throw new Error(`Codec size mismatch for ${fourcc}`);
  return codec;
}

function formatCodec(fourcc: number, storage: GpuStorageFormat): CpuImageCodec | null {
  switch (fourcc >>> 0) {
    case 0x20203852: return unorm8(1, storage);                // R8
    case 0x38385247: return unorm8(2, storage);                // GR88: R then G
    case 0x36314752: return rgb565(storage);                   // RGB565
    case 0x34325241: case 0x34325258:                          // ARGB/XRGB8888: B,G,R,A
      return rgba8(true, storage.opaque, storage);
    case 0x34324241: case 0x34324258:                          // ABGR/XBGR8888: R,G,B,A
      return rgba8(false, storage.opaque, storage);
    case 0x30335241: case 0x30335258:                          // ARGB/XRGB2101010
      return rgb10a2(true, storage.opaque, storage);
    case 0x30334241: case 0x30334258:                          // ABGR/XBGR2101010
      return rgb10a2(false, storage.opaque, storage);
    case 0x48344241: case 0x48344258:                          // ABGR/XBGR16161616F
      return rgba16f(storage.opaque, storage);
    default: return null;
  }
}
