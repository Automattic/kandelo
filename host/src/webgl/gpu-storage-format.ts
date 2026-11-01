import { drmFormatInfo } from "./drm-format-info.js";
/**
 * The WebGL 2 texture storage of a GPU-tier buffer of a DRM format
 * (`DRM_IOCTL_WPK_CREATE_GPU_BO`). Each format's single plane is stored
 * exactly by one sized internal format that WebGL 2 can sample and render
 * into: R8, RG8, RGB565, RGBA8 and RGB10_A2 in core WebGL 2, RGBA16F with
 * EXT_color_buffer_float (the device context enables it; without it the
 * render target is incomplete and allocation fails).
 *
 * A GPU-tier buffer has no CPU bytes, so a format's channel order within
 * a pixel (ARGB vs ABGR) is not observable: both orders hold the same
 * channels in the same storage. A format without alpha (X…) keeps a
 * stored alpha of 1.0 that rendering never writes (opaque-alpha.ts).
 *
 * The kernel's `gpu_storage_format_cpp` lists the same formats.
 */
export interface GpuStorageFormat {
  internalFormat: number;
  format: number;
  type: number;
  /** The format has no alpha channel. */
  opaque: boolean;
}

const RGBA8 = { internalFormat: 0x8058, format: 0x1908, type: 0x1401 };
const RGB10_A2 = { internalFormat: 0x8059, format: 0x1908, type: 0x8368 }; // UNSIGNED_INT_2_10_10_10_REV
const RGBA16F = { internalFormat: 0x881a, format: 0x1908, type: 0x140b }; // HALF_FLOAT

/** RGBA8 storage, the format-agnostic default. */
export const RGBA8_STORAGE: GpuStorageFormat = { ...RGBA8, opaque: false };

/** The format/type pair each sized storage is specified with. */
const UPLOAD: ReadonlyMap<number, { format: number; type: number }> = new Map<number, { format: number; type: number }>([
  [0x8229, { format: 0x1903, type: 0x1401 }], // R8: RED, UNSIGNED_BYTE
  [0x822b, { format: 0x8227, type: 0x1401 }], // RG8: RG, UNSIGNED_BYTE
  [0x8d62, { format: 0x1907, type: 0x8363 }], // RGB565: RGB, UNSIGNED_SHORT_5_6_5
  [RGBA8.internalFormat, RGBA8], [RGB10_A2.internalFormat, RGB10_A2], [RGBA16F.internalFormat, RGBA16F],
]);

/** The storage of a GPU-tier buffer of `fourcc`, from the shared format
 * table (drm-format-info.ts: gpuStorage, opaque). */
export function gpuStorageFormat(fourcc: number): GpuStorageFormat | null {
  const info = drmFormatInfo(fourcc), upload = info && UPLOAD.get(info.gpuStorage);
  return info && upload ? { internalFormat: info.gpuStorage, format: upload.format, type: upload.type, opaque: info.opaque } : null;
}
