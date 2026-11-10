/**
 * YCbCr to RGB conversion of an imported YUV dma-buf image
 * (EGL_EXT_image_dma_buf_import), done on the host when the planes' bytes
 * change (cpu-image-storage.ts), never per draw. The result is the RGBA
 * image an external texture samples (OES_EGL_image_external: "the YUV
 * values will be transformed to RGB values ... in the same colorspace as
 * the original image", so no transfer function is applied).
 *
 * - Samples are normalized as ITU-R BT.601/709/2020 define for the bit
 *   depth: narrow ("studio") range maps Y 16..235 and Cb/Cr 16..240 (times
 *   2^(bits-8)) to [0, 1] and [-0.5, 0.5]; full range maps 0..2^bits-1.
 * - R'G'B' follow from the color space's Kr and Kb:
 *     R = Y + 2(1 - Kr) Pr,  B = Y + 2(1 - Kb) Pb,  G = (Y - Kr R - Kb B) / Kg
 *   and are clamped to [0, 1] and rounded to the output's bits: 8 bits per
 *   channel (RGBA8) for the 8-bit formats, 10 (RGB10_A2) for P010, so no
 *   precision is lost to the output. Alpha is 1.0: no format here has one.
 * - Chroma is reconstructed at every pixel by linear interpolation between
 *   the chroma samples around it, which sit where the siting hints place
 *   them: at the first luma sample of their group (siting 0) or halfway
 *   between (0.5). Edge samples repeat.
 *
 * Absent hints are BT.601, narrow range and siting 0 in both directions,
 * Mesa's defaults for EGL_EXT_image_dma_buf_import.
 */
import {
  DRM_FORMAT_NV12, DRM_FORMAT_NV21, DRM_FORMAT_P010, DRM_FORMAT_UYVY, DRM_FORMAT_YUV420, DRM_FORMAT_YUYV,
  DRM_FORMAT_YVU420, drmFormatInfo, planeHeight, planeWidth,
} from "./drm-format-info.js";

export type YuvColorSpace = 0 | 1 | 2; // BT.601, BT.709, BT.2020
export type YuvConversion = {
  colorSpace: YuvColorSpace;
  fullRange: boolean;
  /** Chroma siting: 0 (co-sited with the first luma sample) or 0.5. */
  sitingH: 0 | 0.5;
  sitingV: 0 | 0.5;
};
export type YuvPlane = { bytes: Uint8Array; offset: number; pitch: number };

/** Kr, Kb of BT.601, BT.709 and BT.2020. */
const COEFFICIENTS: readonly (readonly [number, number])[] = [[0.299, 0.114], [0.2126, 0.0722], [0.2627, 0.0593]];

/** Output bits per color channel of a format's converted image. */
export const yuvOutputBits = (format: number) => format >>> 0 === DRM_FORMAT_P010 ? 10 : 8;

type Taps = { i0: Int32Array; i1: Int32Array; f: Float64Array };
/** For each of `count` luma positions, the two chroma samples around it and
 * the second one's weight. Chroma sample j sits at luma position
 * j * sub + siting * (sub - 1). */
function taps(count: number, sub: number, siting: number, samples: number): Taps {
  const i0 = new Int32Array(count), i1 = new Int32Array(count), f = new Float64Array(count);
  const origin = siting * (sub - 1);
  for (let x = 0; x < count; x++) {
    const u = (x - origin) / sub, j = Math.floor(u);
    i0[x] = Math.min(Math.max(j, 0), samples - 1);
    i1[x] = Math.min(Math.max(j + 1, 0), samples - 1);
    f[x] = u - j;
  }
  return { i0, i1, f };
}

/**
 * Convert a `width` x `height` image of `format`, top row first. Returns
 * RGBA8 bytes (8-bit formats) or RGB10_A2 words, red in the low bits, as
 * GL's UNSIGNED_INT_2_10_10_10_REV (P010). Throws for a format that is not
 * YUV or planes too small for the image.
 */
export function convertYuv(format: number, width: number, height: number, planes: readonly YuvPlane[],
    conversion: YuvConversion): Uint8Array<ArrayBuffer> | Uint32Array<ArrayBuffer> {
  format >>>= 0;
  const info = drmFormatInfo(format);
  if (!info?.isYuv || planes.length !== info.numPlanes) throw new RangeError(`Not a YUV layout: ${format}`);
  const bits = yuvOutputBits(format), max = (1 << bits) - 1, scale = 1 << (bits - 8);
  const [kr, kb] = COEFFICIENTS[conversion.colorSpace], kg = 1 - kr - kb;
  const yOffset = conversion.fullRange ? 0 : 16 * scale, yRange = conversion.fullRange ? max : 219 * scale;
  const cOffset = 128 * scale, cRange = conversion.fullRange ? max : 224 * scale;
  // Chroma samples per row and rows: a packed pair is one chroma sample.
  const cw = planeWidth(info, width, 1);
  const ch = info.numPlanes > 1 ? planeHeight(info, height, 1) : height;
  const columns = taps(width, info.hsub, conversion.sitingH, cw);
  const rows = taps(height, info.vsub, info.vsub > 1 ? conversion.sitingV : 0, ch);
  const views = planes.map(plane => new DataView(plane.bytes.buffer, plane.bytes.byteOffset, plane.bytes.byteLength));

  // Sample readers: luma at (x, y); Cb and Cr of chroma sample (i, j).
  let luma: (x: number, y: number) => number;
  let cb: (i: number, j: number) => number, cr: (i: number, j: number) => number;
  const [p0, p1, p2] = planes;
  switch (format) {
    case DRM_FORMAT_NV12: case DRM_FORMAT_NV21: {
      const u = format === DRM_FORMAT_NV12 ? 0 : 1;
      luma = (x, y) => p0.bytes[p0.offset + y * p0.pitch + x];
      cb = (i, j) => p1.bytes[p1.offset + j * p1.pitch + i * 2 + u];
      cr = (i, j) => p1.bytes[p1.offset + j * p1.pitch + i * 2 + 1 - u];
      break;
    }
    case DRM_FORMAT_YUV420: case DRM_FORMAT_YVU420: {
      const [pu, pv] = format === DRM_FORMAT_YUV420 ? [p1, p2] : [p2, p1];
      luma = (x, y) => p0.bytes[p0.offset + y * p0.pitch + x];
      cb = (i, j) => pu.bytes[pu.offset + j * pu.pitch + i];
      cr = (i, j) => pv.bytes[pv.offset + j * pv.pitch + i];
      break;
    }
    case DRM_FORMAT_YUYV: case DRM_FORMAT_UYVY: {
      // YUYV pairs are Y0,Cb,Y1,Cr; UYVY pairs Cb,Y0,Cr,Y1.
      const [y0, u, v] = format === DRM_FORMAT_YUYV ? [0, 1, 3] : [1, 0, 2];
      luma = (x, y) => p0.bytes[p0.offset + y * p0.pitch + (x >> 1) * 4 + y0 + (x & 1) * 2];
      cb = (i, j) => p0.bytes[p0.offset + j * p0.pitch + i * 4 + u];
      cr = (i, j) => p0.bytes[p0.offset + j * p0.pitch + i * 4 + v];
      break;
    }
    case DRM_FORMAT_P010: {
      // Little-endian 16-bit samples holding 10 bits in their high bits.
      const [v0, v1] = views;
      luma = (x, y) => v0.getUint16(p0.offset + y * p0.pitch + x * 2, true) >>> 6;
      cb = (i, j) => v1.getUint16(p1.offset + j * p1.pitch + i * 4, true) >>> 6;
      cr = (i, j) => v1.getUint16(p1.offset + j * p1.pitch + i * 4 + 2, true) >>> 6;
      break;
    }
    default: throw new RangeError(`Not a YUV layout: ${format}`);
  }

  const pixels = width * height;
  const rgba = bits === 8 ? new Uint8Array(pixels * 4) : null;
  const packed = bits === 10 ? new Uint32Array(pixels) : null;
  const quantize = (value: number) => Math.round((value <= 0 ? 0 : value >= 1 ? 1 : value) * max);
  const lerp = (read: (i: number, j: number) => number, i0: number, i1: number, fx: number,
    j0: number, j1: number, fy: number) =>
    (read(i0, j0) * (1 - fx) + read(i1, j0) * fx) * (1 - fy) + (read(i0, j1) * (1 - fx) + read(i1, j1) * fx) * fy;
  for (let y = 0; y < height; y++) {
    const j0 = rows.i0[y], j1 = rows.i1[y], fy = rows.f[y];
    for (let x = 0; x < width; x++) {
      const i0 = columns.i0[x], i1 = columns.i1[x], fx = columns.f[x];
      const yn = (luma(x, y) - yOffset) / yRange;
      const pb = (lerp(cb, i0, i1, fx, j0, j1, fy) - cOffset) / cRange;
      const pr = (lerp(cr, i0, i1, fx, j0, j1, fy) - cOffset) / cRange;
      const r = yn + 2 * (1 - kr) * pr, b = yn + 2 * (1 - kb) * pb, g = (yn - kr * r - kb * b) / kg;
      const at = y * width + x;
      if (rgba) {
        rgba[at * 4] = quantize(r); rgba[at * 4 + 1] = quantize(g); rgba[at * 4 + 2] = quantize(b); rgba[at * 4 + 3] = 255;
      } else {
        packed![at] = ((3 << 30) | (quantize(b) << 20) | (quantize(g) << 10) | quantize(r)) >>> 0;
      }
    }
  }
  return (rgba ?? packed)!;
}
