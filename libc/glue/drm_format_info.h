/*
 * The memory layout of every pixel format a Kandelo buffer, framebuffer or
 * EGLImage can carry: Linux's `struct drm_format_info`
 * (drivers/gpu/drm/drm_fourcc.c) for those formats.
 *
 * libgbm and libEGL include this table; the kernel
 * (wasm_posix_shared::dri::DRM_FORMATS) and the host
 * (host/src/webgl/drm-format-info.ts) carry the same rows, and
 * host/test/webgl-drm-format-info.test.ts checks that all three agree.
 * One table means a plane is sized, strided and bounded identically by the
 * allocator, the importer, the kernel and the host that reads its bytes.
 * Spelled out with numeric fourccs because libEGL must not depend on
 * libdrm headers.
 */
#ifndef KANDELO_DRM_FORMAT_INFO_H
#define KANDELO_DRM_FORMAT_INFO_H

#include <stdint.h>

struct wpk_drm_format_info {
    uint32_t format;
    uint32_t num_planes;
    uint32_t cpp[3];      /* bytes per sample of each plane */
    uint32_t hsub, vsub;  /* chroma subsampling of planes 1 and 2 */
    int is_yuv;
    uint32_t gpu_storage; /* WebGL 2 internal format of a GPU-tier buffer, 0: none */
    int opaque;           /* alpha position is padding (X...), stored as 1.0 */
    uint32_t plane_formats[3]; /* the single-plane format each plane is read as */
};

#define WPK_FMT_RGB(fourcc, bytes, storage, x) {fourcc, 1, {bytes, 0, 0}, 1, 1, 0, storage, x, {fourcc, 0, 0}}
#define WPK_FMT_YUV(fourcc, planes, c0, c1, c2, h, v, f0, f1, f2) \
    {fourcc, planes, {c0, c1, c2}, h, v, 1, 0, 0, {f0, f1, f2}}

static const struct wpk_drm_format_info wpk_drm_formats[] = {
    WPK_FMT_RGB(0x20203852u, 1, 0x8229u, 0), /* R8 */
    WPK_FMT_RGB(0x38385247u, 2, 0x822bu, 0), /* GR88 */
    WPK_FMT_RGB(0x36314752u, 2, 0x8d62u, 0), /* RGB565 */
    WPK_FMT_RGB(0x34325258u, 4, 0x8058u, 1), /* XRGB8888 */
    WPK_FMT_RGB(0x34325241u, 4, 0x8058u, 0), /* ARGB8888 */
    WPK_FMT_RGB(0x34324258u, 4, 0x8058u, 1), /* XBGR8888 */
    WPK_FMT_RGB(0x34324241u, 4, 0x8058u, 0), /* ABGR8888 */
    WPK_FMT_RGB(0x30335258u, 4, 0x8059u, 1), /* XRGB2101010 */
    WPK_FMT_RGB(0x30335241u, 4, 0x8059u, 0), /* ARGB2101010 */
    WPK_FMT_RGB(0x30334258u, 4, 0x8059u, 1), /* XBGR2101010 */
    WPK_FMT_RGB(0x30334241u, 4, 0x8059u, 0), /* ABGR2101010 */
    WPK_FMT_RGB(0x48344258u, 8, 0x881au, 1), /* XBGR16161616F */
    WPK_FMT_RGB(0x48344241u, 8, 0x881au, 0), /* ABGR16161616F */
    WPK_FMT_YUV(0x3231564eu, 2, 1, 2, 0, 2, 2, 0x20203852u, 0x38385247u, 0), /* NV12: Y, then Cb,Cr pairs */
    WPK_FMT_YUV(0x3132564eu, 2, 1, 2, 0, 2, 2, 0x20203852u, 0x38385247u, 0), /* NV21: Y, then Cr,Cb pairs */
    WPK_FMT_YUV(0x32315559u, 3, 1, 1, 1, 2, 2, 0x20203852u, 0x20203852u, 0x20203852u), /* YUV420: Y, Cb, Cr */
    WPK_FMT_YUV(0x32315659u, 3, 1, 1, 1, 2, 2, 0x20203852u, 0x20203852u, 0x20203852u), /* YVU420: Y, Cr, Cb */
    WPK_FMT_YUV(0x56595559u, 1, 2, 0, 0, 2, 1, 0x56595559u, 0, 0), /* YUYV: Y0,Cb,Y1,Cr */
    WPK_FMT_YUV(0x59565955u, 1, 2, 0, 0, 2, 1, 0x59565955u, 0, 0), /* UYVY: Cb,Y0,Cr,Y1 */
    WPK_FMT_YUV(0x30313050u, 2, 2, 4, 0, 2, 2, 0x20363152u, 0x32335247u, 0), /* P010: 16-bit NV12, 10 high bits */
};

#undef WPK_FMT_RGB
#undef WPK_FMT_YUV

#define WPK_DRM_FORMAT_COUNT (sizeof wpk_drm_formats / sizeof wpk_drm_formats[0])

static inline const struct wpk_drm_format_info *wpk_drm_format_info(uint32_t format) {
    for (unsigned i = 0; i < WPK_DRM_FORMAT_COUNT; i++)
        if (wpk_drm_formats[i].format == format) return &wpk_drm_formats[i];
    return 0;
}

/* drm_format_info_plane_width / _plane_height: planes after the first are
 * subsampled, rounding up. */
static inline uint32_t wpk_drm_plane_width(const struct wpk_drm_format_info *info,
                                           uint32_t width, unsigned plane) {
    return plane == 0 ? width : (uint32_t)(((uint64_t)width + info->hsub - 1) / info->hsub);
}
static inline uint32_t wpk_drm_plane_height(const struct wpk_drm_format_info *info,
                                            uint32_t height, unsigned plane) {
    return plane == 0 ? height : (uint32_t)(((uint64_t)height + info->vsub - 1) / info->vsub);
}

/* Bytes a reader of one row of `plane` touches: drm_format_info_min_pitch,
 * except that a packed YUV row (YUYV, UYVY) of odd width still ends with a
 * whole pixel pair, which carries the last pixel's chroma. */
static inline uint64_t wpk_drm_row_bytes(const struct wpk_drm_format_info *info,
                                         uint32_t width, unsigned plane) {
    if (info->is_yuv && info->num_planes == 1)
        return ((uint64_t)width + info->hsub - 1) / info->hsub * info->hsub * info->cpp[0];
    return (uint64_t)wpk_drm_plane_width(info, width, plane) * info->cpp[plane];
}

#endif
