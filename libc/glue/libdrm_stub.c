/*
 * Minimal libdrm user-space shim for wasm-posix-kernel.
 *
 * Phase C of the DRI buffer-sharing plan
 * (docs/plans/2026-05-25-dri-buffer-sharing-plan.md §C2). Provides
 * the standard libdrm entry points so user code can
 * `#include <xf86drm.h>` and `-ldrm` against this wasm32 sysroot.
 *
 * The kernel-side ioctl handlers live in
 * crates/kernel/src/syscalls.rs::handle_dri_ioctl (Phase A); these
 * wrappers issue the ioctls via channel_syscall.c::ioctl() and
 * present a typical libdrm-shaped API to the caller.
 *
 * Scope (this file is intentionally small):
 *   - drmIoctl              : EINTR-retrying ioctl(3) wrapper.
 *   - drmGetVersion         : DRM_IOCTL_VERSION + synthesised
 *                              client-side identity strings.
 *   - drmFreeVersion        : frees a drmVersionPtr.
 *   - drmCloseBufferHandle  : DRM_IOCTL_GEM_CLOSE wrapper.
 *
 * Buffer-object lifecycle (CREATE_DUMB / MAP_DUMB / DESTROY_DUMB)
 * and PRIME (HANDLE_TO_FD / FD_TO_HANDLE) are wrapped by libgbm in
 * C3/C4; users call libgbm's gbm_bo_* / gbm_bo_get_fd rather than
 * the raw drmMode* / drmPrime* APIs.
 */

#include <xf86drm.h>
#include <xf86drmMode.h>
#include <drm/drm.h>
#include <drm/drm_mode.h>
#include <sys/ioctl.h>
#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int drmIoctl(int fd, unsigned long request, void *arg)
{
    int ret;
    do {
        ret = ioctl(fd, request, arg);
    } while (ret < 0 && errno == EINTR);
    return ret;
}

drmVersionPtr drmGetVersion(int fd)
{
    drmVersionPtr v = (drmVersionPtr) calloc(1, sizeof(*v));
    if (!v) {
        errno = ENOMEM;
        return NULL;
    }

    /* Kernel's DRM_IOCTL_VERSION fills the integer version triple
     * and echoes the name/date/desc pointer fields back unchanged
     * with zero length (Phase A — handle_dri_ioctl notes
     * "We don't write the name/date/desc strings back in v1").
     * Pass a zeroed struct: we don't need string round-trip. */
    struct drm_version req;
    memset(&req, 0, sizeof(req));
    if (drmIoctl(fd, DRM_IOCTL_VERSION, &req) < 0) {
        int save = errno;
        free(v);
        errno = save;
        return NULL;
    }

    v->version_major      = req.version_major;
    v->version_minor      = req.version_minor;
    v->version_patchlevel = req.version_patchlevel;

    /* Synthesise identity strings client-side. The triple is fixed
     * for the wasm-posix-kernel DRI surface; drivers detecting on
     * this name should fall through to the CPU-shared tier (no
     * acceleration claims). Date is the ABI-pin date — deterministic
     * so the same shim compiles to the same identity across builds. */
    static const char NAME[] = "wasm-posix-kernel-dri";
    static const char DESC[] = "Kandelo wasm DRI render node";
    static const char DATE[] = "2026-05-20";

    v->name     = strdup(NAME);
    v->name_len = v->name ? (int)(sizeof(NAME) - 1) : 0;
    v->desc     = strdup(DESC);
    v->desc_len = v->desc ? (int)(sizeof(DESC) - 1) : 0;
    v->date     = strdup(DATE);
    v->date_len = v->date ? (int)(sizeof(DATE) - 1) : 0;

    /* strdup failure leaves the matching pointer NULL and length 0.
     * Upstream libdrm has the same robustness — consumers fall back
     * to the integer version triple for driver detection. */
    return v;
}

void drmFreeVersion(drmVersionPtr v)
{
    if (!v) return;
    free(v->name);
    free(v->date);
    free(v->desc);
    free(v);
}

int drmCloseBufferHandle(int fd, uint32_t handle)
{
    struct drm_gem_close req;
    memset(&req, 0, sizeof(req));
    req.handle = handle;
    return drmIoctl(fd, DRM_IOCTL_GEM_CLOSE, &req);
}

int drmSetMaster(int fd)
{
    return drmIoctl(fd, DRM_IOCTL_SET_MASTER, NULL);
}

int drmDropMaster(int fd)
{
    return drmIoctl(fd, DRM_IOCTL_DROP_MASTER, NULL);
}

/* KMS wrappers: pack libdrm `drmMode*` shape over the byte-identical
 * `struct drm_mode_*` ioctl payloads. Get* allocates, Free* releases. */

drmModeResPtr drmModeGetResources(int fd)
{
    drmModeResPtr res = (drmModeResPtr) calloc(1, sizeof(*res));
    if (!res) { errno = ENOMEM; return NULL; }

    struct drm_mode_card_res req;
    memset(&req, 0, sizeof(req));
    if (drmIoctl(fd, DRM_IOCTL_MODE_GETRESOURCES, &req) < 0) {
        int save = errno; free(res); errno = save; return NULL;
    }

    uint32_t *fbs = NULL, *crtcs = NULL, *conns = NULL, *encs = NULL;
    if (req.count_fbs)        fbs   = (uint32_t*) calloc(req.count_fbs,        sizeof(uint32_t));
    if (req.count_crtcs)      crtcs = (uint32_t*) calloc(req.count_crtcs,      sizeof(uint32_t));
    if (req.count_connectors) conns = (uint32_t*) calloc(req.count_connectors, sizeof(uint32_t));
    if (req.count_encoders)   encs  = (uint32_t*) calloc(req.count_encoders,   sizeof(uint32_t));

    req.fb_id_ptr        = (uintptr_t) fbs;
    req.crtc_id_ptr      = (uintptr_t) crtcs;
    req.connector_id_ptr = (uintptr_t) conns;
    req.encoder_id_ptr   = (uintptr_t) encs;

    if (drmIoctl(fd, DRM_IOCTL_MODE_GETRESOURCES, &req) < 0) {
        int save = errno;
        free(fbs); free(crtcs); free(conns); free(encs); free(res);
        errno = save;
        return NULL;
    }

    res->count_fbs        = (int) req.count_fbs;
    res->fbs              = fbs;
    res->count_crtcs      = (int) req.count_crtcs;
    res->crtcs            = crtcs;
    res->count_connectors = (int) req.count_connectors;
    res->connectors       = conns;
    res->count_encoders   = (int) req.count_encoders;
    res->encoders         = encs;
    res->min_width  = req.min_width;
    res->max_width  = req.max_width;
    res->min_height = req.min_height;
    res->max_height = req.max_height;
    return res;
}

void drmModeFreeResources(drmModeResPtr ptr)
{
    if (!ptr) return;
    free(ptr->fbs);
    free(ptr->crtcs);
    free(ptr->connectors);
    free(ptr->encoders);
    free(ptr);
}

drmModeCrtcPtr drmModeGetCrtc(int fd, uint32_t crtc_id)
{
    drmModeCrtcPtr c = (drmModeCrtcPtr) calloc(1, sizeof(*c));
    if (!c) { errno = ENOMEM; return NULL; }

    struct drm_mode_crtc req;
    memset(&req, 0, sizeof(req));
    req.crtc_id = crtc_id;
    if (drmIoctl(fd, DRM_IOCTL_MODE_GETCRTC, &req) < 0) {
        int save = errno; free(c); errno = save; return NULL;
    }
    c->crtc_id    = req.crtc_id;
    c->buffer_id  = req.fb_id;
    c->x          = req.x;
    c->y          = req.y;
    c->mode_valid = (int) req.mode_valid;
    c->gamma_size = (int) req.gamma_size;
    c->width      = req.mode.hdisplay;
    c->height     = req.mode.vdisplay;
    memcpy(&c->mode, &req.mode, sizeof(c->mode));
    return c;
}

void drmModeFreeCrtc(drmModeCrtcPtr ptr) { free(ptr); }

int drmModeSetCrtc(int fd, uint32_t crtc_id, uint32_t fb_id,
                   uint32_t x, uint32_t y,
                   uint32_t *connectors, int count,
                   drmModeModeInfoPtr mode)
{
    struct drm_mode_crtc req;
    memset(&req, 0, sizeof(req));
    req.set_connectors_ptr = (uintptr_t) connectors;
    req.count_connectors   = (uint32_t) count;
    req.crtc_id = crtc_id;
    req.fb_id   = fb_id;
    req.x = x;
    req.y = y;
    if (mode) {
        req.mode_valid = 1;
        memcpy(&req.mode, mode, sizeof(req.mode));
    }
    return drmIoctl(fd, DRM_IOCTL_MODE_SETCRTC, &req);
}

drmModeEncoderPtr drmModeGetEncoder(int fd, uint32_t encoder_id)
{
    drmModeEncoderPtr e = (drmModeEncoderPtr) calloc(1, sizeof(*e));
    if (!e) { errno = ENOMEM; return NULL; }

    struct drm_mode_get_encoder req;
    memset(&req, 0, sizeof(req));
    req.encoder_id = encoder_id;
    if (drmIoctl(fd, DRM_IOCTL_MODE_GETENCODER, &req) < 0) {
        int save = errno; free(e); errno = save; return NULL;
    }
    e->encoder_id      = req.encoder_id;
    e->encoder_type    = req.encoder_type;
    e->crtc_id         = req.crtc_id;
    e->possible_crtcs  = req.possible_crtcs;
    e->possible_clones = req.possible_clones;
    return e;
}

void drmModeFreeEncoder(drmModeEncoderPtr ptr) { free(ptr); }

drmModeConnectorPtr drmModeGetConnector(int fd, uint32_t connector_id)
{
    drmModeConnectorPtr cn = (drmModeConnectorPtr) calloc(1, sizeof(*cn));
    if (!cn) { errno = ENOMEM; return NULL; }

    struct drm_mode_get_connector req;
    memset(&req, 0, sizeof(req));
    req.connector_id = connector_id;
    if (drmIoctl(fd, DRM_IOCTL_MODE_GETCONNECTOR, &req) < 0) {
        int save = errno; free(cn); errno = save; return NULL;
    }

    drmModeModeInfoPtr modes = NULL;
    uint32_t *encs = NULL;
    if (req.count_modes)
        modes = (drmModeModeInfoPtr) calloc(req.count_modes, sizeof(*modes));
    if (req.count_encoders)
        encs  = (uint32_t*) calloc(req.count_encoders, sizeof(uint32_t));

    req.modes_ptr       = (uintptr_t) modes;
    req.encoders_ptr    = (uintptr_t) encs;
    req.count_props     = 0;
    req.props_ptr       = 0;
    req.prop_values_ptr = 0;

    if (drmIoctl(fd, DRM_IOCTL_MODE_GETCONNECTOR, &req) < 0) {
        int save = errno;
        free(modes); free(encs); free(cn);
        errno = save;
        return NULL;
    }

    cn->connector_id      = req.connector_id;
    cn->encoder_id        = req.encoder_id;
    cn->connector_type    = req.connector_type;
    cn->connector_type_id = req.connector_type_id;
    cn->connection        = (drmModeConnection) req.connection;
    cn->mmWidth           = req.mm_width;
    cn->mmHeight          = req.mm_height;
    cn->subpixel          = (drmModeSubPixel) req.subpixel;
    cn->count_modes       = (int) req.count_modes;
    cn->modes             = modes;
    cn->count_encoders    = (int) req.count_encoders;
    cn->encoders          = encs;
    return cn;
}

void drmModeFreeConnector(drmModeConnectorPtr ptr)
{
    if (!ptr) return;
    free(ptr->modes);
    free(ptr->encoders);
    free(ptr);
}

int drmModeAddFB2(int fd, uint32_t width, uint32_t height,
                  uint32_t pixel_format,
                  uint32_t handles[4], uint32_t pitches[4],
                  uint32_t offsets[4],
                  uint32_t *buf_id, uint32_t flags)
{
    struct drm_mode_fb_cmd2 req;
    memset(&req, 0, sizeof(req));
    req.width  = width;
    req.height = height;
    req.pixel_format = pixel_format;
    req.flags  = flags;
    if (handles) memcpy(req.handles, handles, sizeof(req.handles));
    if (pitches) memcpy(req.pitches, pitches, sizeof(req.pitches));
    if (offsets) memcpy(req.offsets, offsets, sizeof(req.offsets));
    int rc = drmIoctl(fd, DRM_IOCTL_MODE_ADDFB2, &req);
    if (rc == 0 && buf_id) *buf_id = req.fb_id;
    return rc;
}

int drmModeRmFB(int fd, uint32_t bufferId)
{
    return drmIoctl(fd, DRM_IOCTL_MODE_RMFB, &bufferId);
}

int drmModePageFlip(int fd, uint32_t crtc_id, uint32_t fb_id,
                    uint32_t flags, void *user_data)
{
    struct drm_mode_crtc_page_flip req;
    memset(&req, 0, sizeof(req));
    req.crtc_id   = crtc_id;
    req.fb_id     = fb_id;
    req.flags     = flags;
    req.user_data = (uint64_t)(uintptr_t) user_data;
    return drmIoctl(fd, DRM_IOCTL_MODE_PAGE_FLIP, &req);
}

int drmWaitVBlank(int fd, drmVBlankPtr vbl)
{
    return drmIoctl(fd, DRM_IOCTL_WAIT_VBLANK, vbl);
}

int drmHandleEvent(int fd, drmEventContextPtr ctx)
{
    char buffer[4096];
    ssize_t n = read(fd, buffer, sizeof(buffer));
    if (n < 0) return -errno;

    size_t off = 0;
    while (off + sizeof(struct drm_event) <= (size_t) n) {
        struct drm_event *e = (struct drm_event *) (buffer + off);
        if (e->length < sizeof(struct drm_event) ||
            off + e->length > (size_t) n) break;

        if (e->type == DRM_EVENT_VBLANK || e->type == DRM_EVENT_FLIP_COMPLETE) {
            if (e->length >= sizeof(struct drm_event_vblank)) {
                struct drm_event_vblank *v = (struct drm_event_vblank *) e;
                void *ud = (void*)(uintptr_t) v->user_data;
                if (e->type == DRM_EVENT_VBLANK) {
                    if (ctx->vblank_handler)
                        ctx->vblank_handler(fd, v->sequence,
                                            v->tv_sec, v->tv_usec, ud);
                } else if (ctx->version >= 3 && ctx->page_flip_handler2) {
                    ctx->page_flip_handler2(fd, v->sequence,
                                            v->tv_sec, v->tv_usec,
                                            v->crtc_id, ud);
                } else if (ctx->page_flip_handler) {
                    ctx->page_flip_handler(fd, v->sequence,
                                           v->tv_sec, v->tv_usec, ud);
                }
            }
        }
        off += e->length;
    }
    return 0;
}
