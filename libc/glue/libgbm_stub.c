/*
 * Minimal libgbm user-space shim for wasm-posix-kernel.
 *
 * Phase C step 3 (Plan 2 §C3 in
 * docs/plans/2026-05-25-dri-buffer-sharing-plan.md). Implements
 * the buffer-object lifecycle + accessor subset of mesa's libgbm
 * API. Wraps the DRM ioctls Phase A wired and the mmap binding
 * Phase B exposed; consumers using libgbm don't see ioctls.
 *
 * Surface implemented (v1):
 *   - gbm_create_device / gbm_device_destroy
 *   - gbm_device_is_format_supported (32-bpp fourccs)
 *   - gbm_bo_create        (linear, 32-bpp formats only)
 *   - gbm_bo_destroy
 *   - gbm_bo_get_fd        (PRIME export → handle-to-fd)
 *   - gbm_bo_import        (GBM_BO_IMPORT_FD: fd-to-handle)
 *   - gbm_bo_map / gbm_bo_unmap   (single-plane mmap)
 *   - gbm_bo_write         (map + memcpy)
 *   - gbm_bo_set/get_user_data (opaque pointer with destroy cb)
 *   - accessors: get_width / get_height / get_stride / get_format
 *                / get_bpp / get_modifier / get_handle / get_device
 *
 * Surface scanout (added for SDL2 KMSDRM):
 *   - gbm_surface_create / gbm_surface_create_with_modifiers /
 *     gbm_surface_create_with_modifiers2
 *   - gbm_surface_lock_front_buffer / gbm_surface_release_buffer
 *   - gbm_surface_has_free_buffers / gbm_surface_destroy
 *
 * The surface holds a fixed-size two-BO ring (double-buffer);
 * lock_front_buffer hands out an unused BO and release_buffer
 * returns it. Modifiers other than DRM_FORMAT_MOD_LINEAR are
 * ignored — every BO is linear, CPU-shared, single-plane.
 *
 * Declared in <gbm.h> but intentionally NOT implemented (consumers
 * calling these get link-time undefined-symbol errors):
 *   gbm_bo_create_with_modifiers*, gbm_bo_get_*_for_plane,
 *   gbm_bo_get_plane_count, gbm_bo_get_offset, gbm_bo_get_handle_for_plane,
 *   gbm_device_get_fd, gbm_device_get_backend_name,
 *   gbm_device_get_format_modifier_plane_count, gbm_format_get_name.
 */

#include <gbm.h>
#include <xf86drm.h>
#include <drm/drm.h>
#include <drm/drm_mode.h>
#include <drm/drm_fourcc.h>
#include <sys/mman.h>
#include <fcntl.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

struct gbm_device {
    int fd;  /* owned by caller; gbm_device_destroy does NOT close it */
};

struct gbm_bo {
    struct gbm_device *dev;
    uint32_t handle;          /* per-fd DRM handle */
    uint32_t width, height;
    uint32_t stride;          /* pitch in bytes */
    uint32_t format;          /* fourcc */
    uint32_t bpp;             /* bits per pixel */
    uint64_t size;            /* total bytes (pitch * height) */
    uint64_t modifier;        /* DRM_FORMAT_MOD_LINEAR for v1 */
    void *map_addr;           /* lazy: set by gbm_bo_map */
    size_t map_len;
    void *user_data;
    void (*user_data_destroy)(struct gbm_bo *, void *);
    struct gbm_surface *surface;  /* non-NULL when owned by a surface ring */
};

#define WPK_GBM_SURFACE_BO_COUNT 2

struct gbm_surface {
    struct gbm_device *dev;
    uint32_t width, height;
    uint32_t format;
    uint32_t flags;
    struct gbm_bo *bos[WPK_GBM_SURFACE_BO_COUNT];
    int in_use[WPK_GBM_SURFACE_BO_COUNT];
    int next;                /* round-robin cursor for lock_front_buffer */
};

static uint32_t format_bpp(uint32_t fourcc) {
    /* v1: only the 32-bpp ARGB/XRGB/ABGR/XBGR variants are
     * supported, matching what the kernel-side CREATE_DUMB
     * accepts (bpp must be 32; see Phase A6). Extend here as
     * new formats are wired through the kernel. */
    switch (fourcc) {
    case DRM_FORMAT_ARGB8888:
    case DRM_FORMAT_XRGB8888:
    case DRM_FORMAT_ABGR8888:
    case DRM_FORMAT_XBGR8888:
        return 32;
    default:
        return 0;
    }
}

struct gbm_device *gbm_create_device(int fd) {
    struct gbm_device *d = (struct gbm_device *) calloc(1, sizeof(*d));
    if (!d) {
        errno = ENOMEM;
        return NULL;
    }
    d->fd = fd;
    return d;
}

void gbm_device_destroy(struct gbm_device *gbm) {
    free(gbm);
}

struct gbm_bo *gbm_bo_create(struct gbm_device *gbm,
                             uint32_t width, uint32_t height,
                             uint32_t format, uint32_t flags) {
    (void) flags;  /* SCANOUT / CURSOR / RENDERING / LINEAR / etc.
                     * are advisory; v1 always allocates linear
                     * CPU-shared. The kernel rejects flags != 0
                     * on the wire, so don't pass them through. */
    uint32_t bpp = format_bpp(format);
    if (!gbm || !bpp || !width || !height) {
        errno = EINVAL;
        return NULL;
    }

    struct drm_mode_create_dumb req;
    memset(&req, 0, sizeof(req));
    req.height = height;
    req.width  = width;
    req.bpp    = bpp;
    req.flags  = 0;
    if (drmIoctl(gbm->fd, DRM_IOCTL_MODE_CREATE_DUMB, &req) < 0) {
        return NULL;
    }

    struct gbm_bo *bo = (struct gbm_bo *) calloc(1, sizeof(*bo));
    if (!bo) {
        int save = errno;
        /* Roll back kernel-side allocation on host-side OOM. */
        drmCloseBufferHandle(gbm->fd, req.handle);
        errno = save;
        return NULL;
    }
    bo->dev      = gbm;
    bo->handle   = req.handle;
    bo->width    = width;
    bo->height   = height;
    bo->stride   = req.pitch;
    bo->size     = req.size;
    bo->format   = format;
    bo->bpp      = bpp;
    bo->modifier = DRM_FORMAT_MOD_LINEAR;
    return bo;
}

struct gbm_bo *gbm_bo_import(struct gbm_device *gbm, uint32_t type,
                             void *buffer, uint32_t flags) {
    (void) flags;
    if (!gbm || !buffer || type != GBM_BO_IMPORT_FD) {
        /* GBM_BO_IMPORT_WL_BUFFER / EGL_IMAGE / FD_MODIFIER not
         * supported in v1 — the kernel-side handler covers
         * single-fd PRIME only (Phase A7). */
        errno = EINVAL;
        return NULL;
    }
    struct gbm_import_fd_data *d = (struct gbm_import_fd_data *) buffer;
    if (d->fd < 0 || !d->width || !d->height) {
        errno = EINVAL;
        return NULL;
    }
    uint32_t bpp = format_bpp(d->format);
    if (!bpp) {
        errno = EINVAL;
        return NULL;
    }

    struct drm_prime_handle req;
    memset(&req, 0, sizeof(req));
    req.fd    = d->fd;
    req.flags = 0;
    if (drmIoctl(gbm->fd, DRM_IOCTL_PRIME_FD_TO_HANDLE, &req) < 0) {
        return NULL;
    }

    struct gbm_bo *bo = (struct gbm_bo *) calloc(1, sizeof(*bo));
    if (!bo) {
        int save = errno;
        drmCloseBufferHandle(gbm->fd, req.handle);
        errno = save;
        return NULL;
    }
    bo->dev      = gbm;
    bo->handle   = req.handle;
    bo->width    = d->width;
    bo->height   = d->height;
    bo->stride   = d->stride;
    bo->size     = (uint64_t) d->stride * d->height;
    bo->format   = d->format;
    bo->bpp      = bpp;
    bo->modifier = DRM_FORMAT_MOD_LINEAR;
    return bo;
}

int gbm_bo_get_fd(struct gbm_bo *bo) {
    if (!bo) {
        errno = EINVAL;
        return -1;
    }
    struct drm_prime_handle req;
    memset(&req, 0, sizeof(req));
    req.handle = bo->handle;
    req.flags  = O_CLOEXEC | O_RDWR;
    if (drmIoctl(bo->dev->fd, DRM_IOCTL_PRIME_HANDLE_TO_FD, &req) < 0) {
        return -1;
    }
    return req.fd;
}

void *gbm_bo_map(struct gbm_bo *bo,
                 uint32_t x, uint32_t y,
                 uint32_t width, uint32_t height,
                 uint32_t flags,
                 uint32_t *stride, void **map_data) {
    (void) x; (void) y; (void) width; (void) height; (void) flags;
    /* v1: always maps the whole BO. Sub-rectangle support would
     * require MAP_DUMB + per-call mmap of a sub-range; consumers
     * compute sub-regions from the returned base + stride. */
    if (!bo) {
        errno = EINVAL;
        return NULL;
    }

    if (bo->map_addr) {
        /* libgbm's contract permits repeated map calls; re-issue
         * the cached address rather than re-mmapping. */
        if (stride)   *stride   = bo->stride;
        if (map_data) *map_data = bo->map_addr;
        return bo->map_addr;
    }

    struct drm_mode_map_dumb req;
    memset(&req, 0, sizeof(req));
    req.handle = bo->handle;
    if (drmIoctl(bo->dev->fd, DRM_IOCTL_MODE_MAP_DUMB, &req) < 0) {
        return NULL;
    }

    void *addr = mmap(NULL, (size_t) bo->size,
                      PROT_READ | PROT_WRITE,
                      MAP_SHARED,
                      bo->dev->fd,
                      (off_t) req.offset);
    if (addr == MAP_FAILED) {
        return NULL;
    }
    bo->map_addr = addr;
    bo->map_len  = (size_t) bo->size;
    if (stride)   *stride   = bo->stride;
    if (map_data) *map_data = addr;
    return addr;
}

void gbm_bo_unmap(struct gbm_bo *bo, void *map_data) {
    (void) map_data;
    if (!bo || !bo->map_addr) return;
    munmap(bo->map_addr, bo->map_len);
    bo->map_addr = NULL;
    bo->map_len  = 0;
}

void gbm_bo_destroy(struct gbm_bo *bo) {
    if (!bo) return;
    if (bo->user_data_destroy) {
        bo->user_data_destroy(bo, bo->user_data);
        bo->user_data = NULL;
        bo->user_data_destroy = NULL;
    }
    if (bo->map_addr) {
        munmap(bo->map_addr, bo->map_len);
        bo->map_addr = NULL;
        bo->map_len  = 0;
    }
    drmCloseBufferHandle(bo->dev->fd, bo->handle);
    free(bo);
}

int gbm_bo_write(struct gbm_bo *bo, const void *buf, size_t count) {
    if (!bo || !buf) {
        errno = EINVAL;
        return -1;
    }
    if ((uint64_t) count > bo->size) {
        errno = EINVAL;
        return -1;
    }
    /* Reuse the lazy-mapped pointer when present; otherwise mmap
     * the dumb buffer and copy.  gbm_bo_map's flags+rect args are
     * ignored in v1, so passing zeros + NULLs is fine. */
    void *addr = bo->map_addr;
    int mapped_here = 0;
    if (!addr) {
        addr = gbm_bo_map(bo, 0, 0, bo->width, bo->height, 0, NULL, NULL);
        if (!addr) {
            return -1;
        }
        mapped_here = 1;
    }
    memcpy(addr, buf, count);
    if (mapped_here) {
        /* Hold the mapping — repeated writes are common from
         * cursor / icon uploads. gbm_bo_destroy will unmap. */
    }
    return 0;
}

void gbm_bo_set_user_data(struct gbm_bo *bo, void *data,
                          void (*destroy_user_data)(struct gbm_bo *, void *)) {
    if (!bo) return;
    if (bo->user_data_destroy && bo->user_data) {
        bo->user_data_destroy(bo, bo->user_data);
    }
    bo->user_data = data;
    bo->user_data_destroy = destroy_user_data;
}

void *gbm_bo_get_user_data(struct gbm_bo *bo) {
    return bo ? bo->user_data : NULL;
}

uint32_t gbm_bo_get_width(struct gbm_bo *bo)    { return bo->width;    }
uint32_t gbm_bo_get_height(struct gbm_bo *bo)   { return bo->height;   }
uint32_t gbm_bo_get_stride(struct gbm_bo *bo)   { return bo->stride;   }
uint32_t gbm_bo_get_format(struct gbm_bo *bo)   { return bo->format;   }
uint32_t gbm_bo_get_bpp(struct gbm_bo *bo)      { return bo->bpp;      }
uint64_t gbm_bo_get_modifier(struct gbm_bo *bo) { return bo->modifier; }

struct gbm_device *gbm_bo_get_device(struct gbm_bo *bo) {
    return bo->dev;
}

union gbm_bo_handle gbm_bo_get_handle(struct gbm_bo *bo) {
    union gbm_bo_handle h;
    h.u32 = bo->handle;
    return h;
}

int gbm_device_is_format_supported(struct gbm_device *gbm,
                                   uint32_t format, uint32_t flags) {
    (void) gbm; (void) flags;
    /* Match format_bpp's set — the only formats the kernel's
     * CREATE_DUMB path accepts. SDL2 KMSDRM probes ARGB8888 with
     * GBM_BO_USE_SCANOUT|GBM_BO_USE_RENDERING; cursor probes use
     * ARGB8888 with USE_CURSOR|USE_WRITE. Both fall under the same
     * underlying linear dumb buffer in v1. */
    return format_bpp(format) ? 1 : 0;
}

/* ----- gbm_surface_* (double-buffered scanout ring) ---------------
 *
 * SDL2's KMSDRM backend wants a gbm_surface it can hand to
 * eglCreateWindowSurface and then drive page-flipping via
 * gbm_surface_lock_front_buffer / release_buffer.  The mesa
 * implementation backs each surface with a small ring of BOs that
 * EGL renders into and KMS scans out from.
 *
 * Our v1 mirrors that with a fixed two-BO ring, which is enough for
 * a single-window double-buffered demo.  The BOs are allocated
 * eagerly so consumers always observe the same width/height/stride
 * across lock cycles.  Repeated lock without an intervening release
 * (or a release without a prior lock) returns NULL — that matches
 * mesa's behaviour when the ring is exhausted.
 */

static struct gbm_bo *surface_alloc_bo(struct gbm_surface *s) {
    /* Map GBM_BO_USE_* flags onto the kernel-side DUMB path; v1
     * accepts any flag combination because all BOs are linear
     * CPU-shared dumbs. */
    struct gbm_bo *bo = gbm_bo_create(s->dev, s->width, s->height,
                                      s->format, s->flags);
    if (bo) {
        bo->surface = s;
    }
    return bo;
}

struct gbm_surface *gbm_surface_create(struct gbm_device *gbm,
                                       uint32_t width, uint32_t height,
                                       uint32_t format, uint32_t flags) {
    if (!gbm || !width || !height || !format_bpp(format)) {
        errno = EINVAL;
        return NULL;
    }
    struct gbm_surface *s = (struct gbm_surface *) calloc(1, sizeof(*s));
    if (!s) {
        errno = ENOMEM;
        return NULL;
    }
    s->dev    = gbm;
    s->width  = width;
    s->height = height;
    s->format = format;
    s->flags  = flags;
    for (int i = 0; i < WPK_GBM_SURFACE_BO_COUNT; i++) {
        s->bos[i] = surface_alloc_bo(s);
        if (!s->bos[i]) {
            int save = errno;
            for (int j = 0; j < i; j++) {
                s->bos[j]->surface = NULL;
                gbm_bo_destroy(s->bos[j]);
            }
            free(s);
            errno = save;
            return NULL;
        }
    }
    return s;
}

struct gbm_surface *
gbm_surface_create_with_modifiers(struct gbm_device *gbm,
                                  uint32_t width, uint32_t height,
                                  uint32_t format,
                                  const uint64_t *modifiers,
                                  const unsigned int count) {
    (void) modifiers; (void) count;
    /* v1 only emits DRM_FORMAT_MOD_LINEAR; ignoring caller-supplied
     * modifier set matches the documented mesa fallback when no
     * requested modifier is available. */
    return gbm_surface_create(gbm, width, height, format,
                              GBM_BO_USE_SCANOUT | GBM_BO_USE_RENDERING);
}

struct gbm_surface *
gbm_surface_create_with_modifiers2(struct gbm_device *gbm,
                                   uint32_t width, uint32_t height,
                                   uint32_t format,
                                   const uint64_t *modifiers,
                                   const unsigned int count,
                                   uint32_t flags) {
    (void) modifiers; (void) count;
    return gbm_surface_create(gbm, width, height, format, flags);
}

struct gbm_bo *gbm_surface_lock_front_buffer(struct gbm_surface *surface) {
    if (!surface) {
        errno = EINVAL;
        return NULL;
    }
    /* Hand out the next free BO in round-robin order.  Consumers
     * are expected to release the previous frame's BO before
     * locking the next; if both BOs are in use we return NULL +
     * EBUSY (mesa returns NULL in the equivalent ring-exhausted
     * case). */
    for (int i = 0; i < WPK_GBM_SURFACE_BO_COUNT; i++) {
        int idx = (surface->next + i) % WPK_GBM_SURFACE_BO_COUNT;
        if (!surface->in_use[idx]) {
            surface->in_use[idx] = 1;
            surface->next = (idx + 1) % WPK_GBM_SURFACE_BO_COUNT;
            return surface->bos[idx];
        }
    }
    errno = EBUSY;
    return NULL;
}

void gbm_surface_release_buffer(struct gbm_surface *surface, struct gbm_bo *bo) {
    if (!surface || !bo) return;
    for (int i = 0; i < WPK_GBM_SURFACE_BO_COUNT; i++) {
        if (surface->bos[i] == bo) {
            surface->in_use[i] = 0;
            return;
        }
    }
    /* Releasing a BO that doesn't belong to this surface is a
     * caller bug; mesa silently ignores. */
}

int gbm_surface_has_free_buffers(struct gbm_surface *surface) {
    if (!surface) return 0;
    int free_count = 0;
    for (int i = 0; i < WPK_GBM_SURFACE_BO_COUNT; i++) {
        if (!surface->in_use[i]) free_count++;
    }
    return free_count;
}

void gbm_surface_destroy(struct gbm_surface *surface) {
    if (!surface) return;
    for (int i = 0; i < WPK_GBM_SURFACE_BO_COUNT; i++) {
        if (surface->bos[i]) {
            surface->bos[i]->surface = NULL;
            gbm_bo_destroy(surface->bos[i]);
            surface->bos[i] = NULL;
        }
    }
    free(surface);
}
