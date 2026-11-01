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

export function gpuStorageFormat(fourcc: number): GpuStorageFormat | null {
  switch (fourcc >>> 0) {
    case 0x20203852: return { internalFormat: 0x8229, format: 0x1903, type: 0x1401, opaque: false }; // R8
    case 0x38385247: return { internalFormat: 0x822b, format: 0x8227, type: 0x1401, opaque: false }; // GR88: RG8
    case 0x36314752: return { internalFormat: 0x8d62, format: 0x1907, type: 0x8363, opaque: false }; // RGB565
    case 0x34325241: case 0x34324241: return { ...RGBA8, opaque: false };   // ARGB/ABGR8888
    case 0x34325258: case 0x34324258: return { ...RGBA8, opaque: true };    // XRGB/XBGR8888
    case 0x30335241: case 0x30334241: return { ...RGB10_A2, opaque: false }; // ARGB/ABGR2101010
    case 0x30335258: case 0x30334258: return { ...RGB10_A2, opaque: true };  // XRGB/XBGR2101010
    case 0x48344241: return { ...RGBA16F, opaque: false };                   // ABGR16161616F
    case 0x48344258: return { ...RGBA16F, opaque: true };                    // XBGR16161616F
    default: return null;
  }
}
