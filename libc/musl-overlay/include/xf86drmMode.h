/*
 * Minimal <xf86drmMode.h> for wasm-posix-kernel.
 *
 * KMS userland API mirroring upstream libdrm. Wrappers live in
 * libc/glue/libdrm_stub.c; the underlying ioctls are handled by
 * crates/kernel/src/syscalls.rs::handle_dri_card_ioctl (Phase A of
 * docs/plans/2026-06-08-dri-kms-plan.md).
 */

#ifndef _XF86DRMMODE_H
#define _XF86DRMMODE_H 1

#include <stdint.h>
#include <drm/drm.h>
#include <drm/drm_mode.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    DRM_MODE_CONNECTED         = 1,
    DRM_MODE_DISCONNECTED      = 2,
    DRM_MODE_UNKNOWNCONNECTION = 3,
} drmModeConnection;

typedef enum {
    DRM_MODE_SUBPIXEL_UNKNOWN        = 1,
    DRM_MODE_SUBPIXEL_HORIZONTAL_RGB = 2,
    DRM_MODE_SUBPIXEL_HORIZONTAL_BGR = 3,
    DRM_MODE_SUBPIXEL_VERTICAL_RGB   = 4,
    DRM_MODE_SUBPIXEL_VERTICAL_BGR   = 5,
    DRM_MODE_SUBPIXEL_NONE           = 6,
} drmModeSubPixel;

typedef struct _drmModeModeInfo {
    uint32_t clock;
    uint16_t hdisplay, hsync_start, hsync_end, htotal, hskew;
    uint16_t vdisplay, vsync_start, vsync_end, vtotal, vscan;
    uint32_t vrefresh;
    uint32_t flags;
    uint32_t type;
    char     name[DRM_DISPLAY_MODE_LEN];
} drmModeModeInfo, *drmModeModeInfoPtr;

typedef struct _drmModeRes {
    int       count_fbs;
    uint32_t *fbs;
    int       count_crtcs;
    uint32_t *crtcs;
    int       count_connectors;
    uint32_t *connectors;
    int       count_encoders;
    uint32_t *encoders;
    uint32_t  min_width, max_width;
    uint32_t  min_height, max_height;
} drmModeRes, *drmModeResPtr;

typedef struct _drmModeCrtc {
    uint32_t        crtc_id;
    uint32_t        buffer_id;
    uint32_t        x, y;
    uint32_t        width, height;
    int             mode_valid;
    drmModeModeInfo mode;
    int             gamma_size;
} drmModeCrtc, *drmModeCrtcPtr;

typedef struct _drmModeEncoder {
    uint32_t encoder_id;
    uint32_t encoder_type;
    uint32_t crtc_id;
    uint32_t possible_crtcs;
    uint32_t possible_clones;
} drmModeEncoder, *drmModeEncoderPtr;

typedef struct _drmModeConnector {
    uint32_t           connector_id;
    uint32_t           encoder_id;
    uint32_t           connector_type;
    uint32_t           connector_type_id;
    drmModeConnection  connection;
    uint32_t           mmWidth, mmHeight;
    drmModeSubPixel    subpixel;
    int                count_modes;
    drmModeModeInfoPtr modes;
    int                count_encoders;
    uint32_t          *encoders;
} drmModeConnector, *drmModeConnectorPtr;

typedef union _drmVBlank {
    struct drm_wait_vblank_request request;
    struct drm_wait_vblank_reply   reply;
} drmVBlank, *drmVBlankPtr;

typedef struct _drmEventContext {
    int version;
    void (*vblank_handler)(int fd,
                           unsigned int sequence,
                           unsigned int tv_sec,
                           unsigned int tv_usec,
                           void *user_data);
    void (*page_flip_handler)(int fd,
                              unsigned int sequence,
                              unsigned int tv_sec,
                              unsigned int tv_usec,
                              void *user_data);
    void (*page_flip_handler2)(int fd,
                               unsigned int sequence,
                               unsigned int tv_sec,
                               unsigned int tv_usec,
                               unsigned int crtc_id,
                               void *user_data);
    void (*sequence_handler)(int fd,
                             uint64_t sequence,
                             uint64_t ns,
                             uint64_t user_data);
} drmEventContext, *drmEventContextPtr;

drmModeResPtr       drmModeGetResources(int fd);
void                drmModeFreeResources(drmModeResPtr ptr);

drmModeCrtcPtr      drmModeGetCrtc(int fd, uint32_t crtc_id);
void                drmModeFreeCrtc(drmModeCrtcPtr ptr);
int                 drmModeSetCrtc(int fd, uint32_t crtc_id,
                                   uint32_t fb_id,
                                   uint32_t x, uint32_t y,
                                   uint32_t *connectors, int count,
                                   drmModeModeInfoPtr mode);

drmModeConnectorPtr drmModeGetConnector(int fd, uint32_t connector_id);
void                drmModeFreeConnector(drmModeConnectorPtr ptr);

drmModeEncoderPtr   drmModeGetEncoder(int fd, uint32_t encoder_id);
void                drmModeFreeEncoder(drmModeEncoderPtr ptr);

int                 drmModeAddFB2(int fd,
                                  uint32_t width, uint32_t height,
                                  uint32_t pixel_format,
                                  uint32_t handles[4],
                                  uint32_t pitches[4],
                                  uint32_t offsets[4],
                                  uint32_t *buf_id, uint32_t flags);
int                 drmModeRmFB(int fd, uint32_t bufferId);

int                 drmModePageFlip(int fd, uint32_t crtc_id,
                                    uint32_t fb_id,
                                    uint32_t flags, void *user_data);

int                 drmWaitVBlank(int fd, drmVBlankPtr vbl);
int                 drmHandleEvent(int fd, drmEventContextPtr ctx);

#ifdef __cplusplus
}
#endif

#endif /* _XF86DRMMODE_H */
