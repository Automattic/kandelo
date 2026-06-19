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
 *   - gbm_bo_create        (linear, 32-bpp formats only)
 *   - gbm_bo_destroy
 *   - gbm_bo_get_fd        (PRIME export → handle-to-fd)
 *   - gbm_bo_import        (GBM_BO_IMPORT_FD: fd-to-handle)
 *   - gbm_bo_map / gbm_bo_unmap   (single-plane mmap)
 *   - accessors: get_width / get_height / get_stride / get_format
 *                / get_bpp / get_modifier / get_handle / get_device
 *
 * Declared in <gbm.h> but intentionally NOT implemented (consumers
 * calling these get link-time undefined-symbol errors):
 *   gbm_bo_create_with_modifiers*, gbm_bo_get_*_for_plane,
 *   gbm_bo_get_plane_count, gbm_bo_get_offset, gbm_bo_get_handle_for_plane,
 *   gbm_bo_write, gbm_bo_set/get_user_data, gbm_surface_*,
 *   gbm_device_get_fd, gbm_device_get_backend_name,
 *   gbm_device_is_format_supported,
 *   gbm_device_get_format_modifier_plane_count, gbm_format_get_name.
 * Phase C v1 is deliberately minimal — every BO is linear,
 * CPU-shared, single-plane, with the DRM_FORMAT_MOD_LINEAR modifier.
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
    if (bo->map_addr) {
        munmap(bo->map_addr, bo->map_len);
        bo->map_addr = NULL;
        bo->map_len  = 0;
    }
    drmCloseBufferHandle(bo->dev->fd, bo->handle);
    free(bo);
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
