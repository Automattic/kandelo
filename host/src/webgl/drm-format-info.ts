/**
 * The memory layout of every pixel format a Kandelo buffer, framebuffer or
 * EGLImage can carry: Linux's `struct drm_format_info`
 * (drivers/gpu/drm/drm_fourcc.c) for those formats.
 *
 * The kernel (`wasm_posix_shared::dri::DRM_FORMATS`) and libgbm/libEGL
 * (`libc/glue/drm_format_info.h`) carry the same rows;
 * host/test/webgl-drm-format-info.test.ts checks that all three agree, so
 * the allocator, the importer, the kernel and the host size, stride and
 * bound a plane identically.
 */
export interface DrmFormatInfo {
  format: number;
  numPlanes: number;
  /** Bytes per sample of each plane; unused planes are 0. */
  cpp: readonly [number, number, number];
  /** Chroma subsampling of planes 1 and 2. */
  hsub: number;
  vsub: number;
  isYuv: boolean;
  /** WebGL 2 sized internal format of a GPU-tier buffer of this format (0:
   * none can hold it); channel orders share storage. */
  gpuStorage: number;
  /** The alpha position is padding (X...), stored as 1.0. */
  opaque: boolean;
}

const rgb = (format: number, cpp: number, gpuStorage: number, opaque: boolean): DrmFormatInfo =>
  ({ format, numPlanes: 1, cpp: [cpp, 0, 0], hsub: 1, vsub: 1, isYuv: false, gpuStorage, opaque });
const yuv = (format: number, numPlanes: number, cpp: [number, number, number], hsub: number, vsub: number): DrmFormatInfo =>
  ({ format, numPlanes, cpp, hsub, vsub, isYuv: true, gpuStorage: 0, opaque: false });
const R8 = 0x8229, RG8 = 0x822b, RGB565 = 0x8d62, RGBA8 = 0x8058, RGB10_A2 = 0x8059, RGBA16F = 0x881a;

export const DRM_FORMAT_NV12 = 0x3231564e, DRM_FORMAT_NV21 = 0x3132564e;
export const DRM_FORMAT_YUV420 = 0x32315559, DRM_FORMAT_YVU420 = 0x32315659;
export const DRM_FORMAT_YUYV = 0x56595559, DRM_FORMAT_UYVY = 0x59565955;
export const DRM_FORMAT_P010 = 0x30313050;

export const DRM_FORMATS: readonly DrmFormatInfo[] = [
  rgb(0x20203852, 1, R8, false), // R8
  rgb(0x38385247, 2, RG8, false), // GR88
  rgb(0x36314752, 2, RGB565, false), // RGB565
  rgb(0x34325258, 4, RGBA8, true), // XRGB8888
  rgb(0x34325241, 4, RGBA8, false), // ARGB8888
  rgb(0x34324258, 4, RGBA8, true), // XBGR8888
  rgb(0x34324241, 4, RGBA8, false), // ABGR8888
  rgb(0x30335258, 4, RGB10_A2, true), // XRGB2101010
  rgb(0x30335241, 4, RGB10_A2, false), // ARGB2101010
  rgb(0x30334258, 4, RGB10_A2, true), // XBGR2101010
  rgb(0x30334241, 4, RGB10_A2, false), // ABGR2101010
  rgb(0x48344258, 8, RGBA16F, true), // XBGR16161616F
  rgb(0x48344241, 8, RGBA16F, false), // ABGR16161616F
  yuv(DRM_FORMAT_NV12, 2, [1, 2, 0], 2, 2),   // Y, then Cb,Cr pairs
  yuv(DRM_FORMAT_NV21, 2, [1, 2, 0], 2, 2),   // Y, then Cr,Cb pairs
  yuv(DRM_FORMAT_YUV420, 3, [1, 1, 1], 2, 2), // Y, Cb, Cr
  yuv(DRM_FORMAT_YVU420, 3, [1, 1, 1], 2, 2), // Y, Cr, Cb
  yuv(DRM_FORMAT_YUYV, 1, [2, 0, 0], 2, 1),   // Y0,Cb,Y1,Cr
  yuv(DRM_FORMAT_UYVY, 1, [2, 0, 0], 2, 1),   // Cb,Y0,Cr,Y1
  yuv(DRM_FORMAT_P010, 2, [2, 4, 0], 2, 2),   // 16-bit NV12, 10 high bits
];

const byFormat = new Map(DRM_FORMATS.map(info => [info.format, info]));

export function drmFormatInfo(format: number): DrmFormatInfo | null {
  return byFormat.get(format >>> 0) ?? null;
}

/** drm_format_info_plane_width: planes after the first are subsampled,
 * rounding up. */
export function planeWidth(info: DrmFormatInfo, width: number, plane: number): number {
  return plane === 0 ? width : Math.ceil(width / info.hsub);
}
export function planeHeight(info: DrmFormatInfo, height: number, plane: number): number {
  return plane === 0 ? height : Math.ceil(height / info.vsub);
}
/** Bytes a reader of one row of `plane` touches: drm_format_info_min_pitch,
 * except that a packed YUV row (YUYV, UYVY) of odd width still ends with a
 * whole pixel pair, which carries the last pixel's chroma. */
export function rowBytes(info: DrmFormatInfo, width: number, plane: number): number {
  if (info.isYuv && info.numPlanes === 1) return Math.ceil(width / info.hsub) * info.hsub * info.cpp[0];
  return planeWidth(info, width, plane) * info.cpp[plane];
}
