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
 *   - gbm_bo_create_with_modifiers / gbm_bo_create_with_modifiers2
 *                          (LINEAR or implicit modifiers only)
 *   - gbm_bo_destroy
 *   - gbm_bo_get_fd        (PRIME export → handle-to-fd)
 *   - gbm_bo_import        (GBM_BO_IMPORT_FD: fd-to-handle)
 *   - gbm_bo_map / gbm_bo_unmap   (single-plane mmap)
 *   - gbm_bo_write         (map + memcpy)
 *   - gbm_bo_set/get_user_data (opaque pointer with destroy cb)
 *   - accessors: get_width / get_height / get_stride / get_format
 *                / get_bpp / get_modifier / get_handle / get_device
 *   - single-plane accessors: get_plane_count / get_offset /
 *                get_stride_for_plane / get_handle_for_plane /
 *                get_fd_for_plane
 *   - gbm_device_get_fd / gbm_device_get_backend_name
 *
 * Surface scanout (added for SDL2 KMSDRM):
 *   - gbm_surface_create / gbm_surface_create_with_modifiers /
 *     gbm_surface_create_with_modifiers2
 *   - gbm_surface_lock_front_buffer / gbm_surface_release_buffer
 *   - gbm_surface_has_free_buffers / gbm_surface_destroy
 *
 * EGL owns a render-buffer lease distinct from the public window and
 * locked front buffers. Only an accepted swap publishes a front. A bounded
 * four-slot GPU pool never reuses locked storage; KMS alone selects scanout.
 * CPU-facing window rendering remains unsupported rather than silently
 * replacing mappable storage with a GPU-only BO.
 *
 * Format queries report the single linear plane actually allocated here;
 * names use the public fourcc spelling, including the two legacy aliases.
 */

#include <gbm.h>
#include "gbm_window.h"
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
#include <limits.h>
#include <unistd.h>
#include <pthread.h>

/* WPK GPU-tier bo allocator (mirrors wasm_posix_shared::dri). A GPU-tier
 * bo is backed by a host WebGLTexture (+FBO) on the compositor's shared
 * context — unmappable on the CPU side, sampled/rendered zero-copy via
 * the multiplexer. See DRM_IOCTL_WPK_CREATE_GPU_BO in shared. On return
 * the `format` slot carries the per-fd handle and `usage` carries the
 * stride (the 16-byte encoding is preserved). */
#define WPK_DRM_IOCTL_CREATE_GPU_BO 0xc01064e0u  /* _IOWR('d', 0xE0, 16) */
struct wpk_drm_gpu_bo_create {
    uint32_t width;
    uint32_t height;
    uint32_t format;   /* in: fourcc.  out: per-fd handle */
    uint32_t usage;    /* in: GBM_BO_USE_*.  out: stride (bytes) */
};

struct gbm_device {
    int fd;          /* retained file alias, owned until the last object retires */
    int public_fd;   /* caller's original descriptor, returned by the public API */
    unsigned references;
    uint64_t identity;
    struct gbm_device *live_next;
};

static pthread_mutex_t device_mutex = PTHREAD_MUTEX_INITIALIZER;
static struct gbm_device *live_devices;
static uint64_t next_device_identity = 1;

static int retain_device(struct gbm_device *device) {
    int retained = 0;
    pthread_mutex_lock(&device_mutex);
    for (struct gbm_device *p = live_devices; p; p = p->live_next) {
        if (p == device && p->references != UINT_MAX) {
            ++p->references;
            retained = 1;
            break;
        }
    }
    pthread_mutex_unlock(&device_mutex);
    if (!retained) errno = EINVAL;
    return retained;
}

static int retain_owned_device(struct gbm_device *device) {
    pthread_mutex_lock(&device_mutex);
    int retained = device->references != UINT_MAX;
    if (retained) ++device->references;
    pthread_mutex_unlock(&device_mutex);
    if (!retained) errno = EOVERFLOW;
    return retained;
}

/* A public device name can disappear while BOs or windows still own its
 * file. Retire the private alias only after their independent holds end. */
static void release_device(struct gbm_device *device) {
    pthread_mutex_lock(&device_mutex);
    int retired = --device->references == 0;
    pthread_mutex_unlock(&device_mutex);
    if (retired) {
        close(device->fd);
        free(device);
    }
}

/* EGL receives an opaque native handle. Resolve only our live devices;
 * neither a foreign pointer nor a recycled allocation selects an old display. */
int _wpk_gbm_device_metadata(const void *native, int *fd, uint64_t *identity) {
    int found = 0;
    pthread_mutex_lock(&device_mutex);
    for (struct gbm_device *d = live_devices; d; d = d->live_next) {
        if (d == native) {
            *fd = d->fd;
            *identity = d->identity;
            found = 1;
            break;
        }
    }
    pthread_mutex_unlock(&device_mutex);
    return found;
}

struct gbm_bo {
    struct gbm_device *dev;
    uint32_t handle;          /* per-fd DRM handle */
    uint32_t width, height;
    uint32_t stride;          /* pitch in bytes */
    uint32_t format;          /* fourcc */
    uint32_t bpp;             /* bits per pixel */
    uint64_t size;            /* total bytes (pitch * height) */
    uint64_t modifier;        /* DRM_FORMAT_MOD_LINEAR for v1 */
    int is_gpu;               /* 1 = GPU-tier (unmappable WebGLTexture bo) */
    struct gbm_mapping *mappings;
    void *map_addr;           /* shared by this BO's active CPU map leases */
    size_t map_len;
    void *user_data;
    void (*user_data_destroy)(struct gbm_bo *, void *);
    struct gbm_surface *surface;  /* non-NULL when owned by a surface ring */
    struct gbm_bo *handle_next;
};

/* PRIME reimport returns the existing GEM name on this DRM file. Public
 * GBM objects own separate lifetimes, so only the final peer closes it.
 * Serialize import with removal: an ioctl followed by later registration
 * could otherwise lose the handle to a concurrent peer's destruction. */
static pthread_mutex_t handle_mutex = PTHREAD_MUTEX_INITIALIZER;
static struct gbm_bo *live_bos;
static void register_bo(struct gbm_bo *bo) {
    pthread_mutex_lock(&handle_mutex);
    bo->handle_next = live_bos;
    live_bos = bo;
    pthread_mutex_unlock(&handle_mutex);
}

struct gbm_mapping {
    struct gbm_mapping *next;
    uintptr_t token;
    int internal_release_pending;
};
static pthread_mutex_t mapping_mutex = PTHREAD_MUTEX_INITIALIZER;
static uintptr_t next_mapping_token = 1;

#define WPK_GBM_SURFACE_BO_COUNT 4
#define WPK_GBM_SURFACE_INITIAL_BO_COUNT 2

struct gbm_surface {
    struct gbm_device *dev;
    uint32_t width, height, format, flags;
    struct gbm_bo *bos[WPK_GBM_SURFACE_BO_COUNT];
    int in_use[WPK_GBM_SURFACE_BO_COUNT];
    int public_live, window_owned;
    int back, front, pending;
    struct gbm_surface *live_next;
};

/* EGL native windows are opaque. Look up our own live handles rather than
 * interpreting another backend's pointer using the GBM structure layout. */
static pthread_mutex_t surface_mutex = PTHREAD_MUTEX_INITIALIZER;
static struct gbm_surface *live_surfaces;

int _wpk_gbm_surface_metadata(const void *window, uint32_t *width, uint32_t *height,
                              uint32_t *format, uint32_t *flags) {
    int found = 0;
    pthread_mutex_lock(&surface_mutex);
    for (struct gbm_surface *s = live_surfaces; s; s = s->live_next) {
        if (s == window && s->public_live) {
            *width = s->width;
            *height = s->height;
            *format = s->format;
            *flags = s->flags;
            found = 1;
            break;
        }
    }
    pthread_mutex_unlock(&surface_mutex);
    return found;
}
int _wpk_gbm_surface_dimensions(const void *window, uint32_t *width, uint32_t *height) {
    uint32_t format, flags;
    return _wpk_gbm_surface_metadata(window, width, height, &format, &flags);
}

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

static uint32_t canonical_format(uint32_t format) {
    if (format == GBM_BO_FORMAT_XRGB8888) return GBM_FORMAT_XRGB8888;
    if (format == GBM_BO_FORMAT_ARGB8888) return GBM_FORMAT_ARGB8888;
    return format;
}

int gbm_device_get_format_modifier_plane_count(struct gbm_device *gbm,
                                               uint32_t format, uint64_t modifier) {
    if (!gbm || !format_bpp(canonical_format(format)) || modifier != DRM_FORMAT_MOD_LINEAR) {
        errno = EINVAL;
        return -1;
    }
    return 1;
}

char *gbm_format_get_name(uint32_t format, struct gbm_format_name_desc *desc) {
    format = canonical_format(format);
    for (unsigned i = 0; i < 4; ++i) desc->name[i] = (char)(format >> (i * 8));
    desc->name[4] = '\0';
    return desc->name;
}

struct gbm_device *gbm_create_device(int fd) {
    if (fcntl(fd, F_GETFD) < 0) return NULL;
    struct gbm_device *d = (struct gbm_device *) calloc(1, sizeof(*d));
    if (!d) {
        errno = ENOMEM;
        return NULL;
    }
    d->fd = fcntl(fd, F_DUPFD_CLOEXEC, 0);
    if (d->fd < 0) { int save = errno; free(d); errno = save; return NULL; }
    d->public_fd = fd;
    d->references = 1;
    pthread_mutex_lock(&device_mutex);
    if (next_device_identity == 0) {
        pthread_mutex_unlock(&device_mutex);
        close(d->fd);
        free(d);
        errno = EOVERFLOW;
        return NULL;
    }
    d->identity = next_device_identity;
    next_device_identity = next_device_identity == UINT64_MAX ? 0 : next_device_identity + 1;
    d->live_next = live_devices;
    live_devices = d;
    pthread_mutex_unlock(&device_mutex);
    return d;
}

void gbm_device_destroy(struct gbm_device *gbm) {
    int removed = 0;
    pthread_mutex_lock(&device_mutex);
    struct gbm_device **slot = &live_devices;
    while (*slot && *slot != gbm) slot = &(*slot)->live_next;
    if (*slot) {
        *slot = gbm->live_next;
        removed = 1;
    }
    pthread_mutex_unlock(&device_mutex);
    if (removed) release_device(gbm);
}

int gbm_device_get_fd(struct gbm_device *gbm) {
    return gbm->public_fd;
}

const char *gbm_device_get_backend_name(struct gbm_device *gbm) {
    (void) gbm;
    return "kandelo";
}

/* A bo purely used as a GL render target — RENDERING set, none of the
 * CPU-facing usages (SCANOUT, CURSOR, WRITE, LINEAR) — can be a GPU-tier
 * bo: unmappable, backed by a host WebGLTexture the compositor samples
 * zero-copy. Anything the CPU must map (the scanout ring is SCANOUT|
 * RENDERING; cursors are CURSOR|WRITE) stays a linear dumb bo. */
static int usage_wants_gpu_tier(uint32_t flags) {
    const uint32_t cpu_facing =
        GBM_BO_USE_SCANOUT | GBM_BO_USE_CURSOR |
        GBM_BO_USE_WRITE   | GBM_BO_USE_LINEAR;
    return (flags & GBM_BO_USE_RENDERING) && !(flags & cpu_facing);
}

/* The modifier entry points are the ones a renderer that draws into its
 * own scanout buffers allocates through (wlroots' gbm allocator). Their
 * SCANOUT|RENDERING bos are GPU-tier: the renderer fills them with GL, and
 * the host shows a GPU-tier scanout buffer on the GL-owned display canvas
 * at each flip. gbm_bo_create keeps SCANOUT CPU-facing for the gbm_surface
 * ring and for compositors that blit into their scanout buffer on the CPU. */
static int modifier_usage_wants_gpu_tier(uint32_t flags) {
    const uint32_t cpu_facing =
        GBM_BO_USE_CURSOR | GBM_BO_USE_WRITE | GBM_BO_USE_LINEAR;
    return (flags & GBM_BO_USE_RENDERING) && !(flags & cpu_facing);
}

static struct gbm_bo *bo_create(struct gbm_device *gbm,
                                uint32_t width, uint32_t height,
                                uint32_t format, uint32_t flags,
                                int gpu_tier, int owned_device) {
    uint32_t bpp = format_bpp(format);
    if (!gbm || !bpp || !width || !height) {
        errno = EINVAL;
        return NULL;
    }
    if (!(owned_device ? retain_owned_device(gbm) : retain_device(gbm))) return NULL;

    struct gbm_bo *bo = (struct gbm_bo *) calloc(1, sizeof(*bo));
    if (!bo) {
        release_device(gbm);
        errno = ENOMEM;
        return NULL;
    }
    bo->dev      = gbm;
    bo->width    = width;
    bo->height   = height;
    bo->format   = format;
    bo->bpp      = bpp;
    bo->modifier = DRM_FORMAT_MOD_LINEAR;

    /* GPU tier first for render-only bos. On any error — notably ENOSYS
     * when the host has no shared GL context yet (headless, or before the
     * compositor's context exists) — fall through to a CPU-tier dumb bo,
     * which BIND_FOREIGN_TEXTURE still samples via a host-side upload. */
    if (gpu_tier) {
        struct wpk_drm_gpu_bo_create greq;
        memset(&greq, 0, sizeof(greq));
        greq.width  = width;
        greq.height = height;
        greq.format = format;
        greq.usage  = flags;
        if (drmIoctl(gbm->fd, WPK_DRM_IOCTL_CREATE_GPU_BO, &greq) == 0) {
            bo->handle = greq.format;   /* out: per-fd handle */
            bo->stride = greq.usage;    /* out: stride (bytes) */
            bo->size   = (uint64_t) greq.usage * height;
            bo->is_gpu = 1;
            register_bo(bo);
            return bo;
        }
        if (gpu_tier == 2) {
            int save = errno;
            free(bo);
            release_device(gbm);
            errno = save;
            return NULL;
        }
        /* Optional GPU preference may degrade to CPU tier below. */
    }

    struct drm_mode_create_dumb req;
    memset(&req, 0, sizeof(req));
    req.height = height;
    req.width  = width;
    req.bpp    = bpp;
    req.flags  = 0;
    if (drmIoctl(gbm->fd, DRM_IOCTL_MODE_CREATE_DUMB, &req) < 0) {
        int save = errno;
        free(bo);
        release_device(gbm);
        errno = save;
        return NULL;
    }
    bo->handle = req.handle;
    bo->stride = req.pitch;
    bo->size   = req.size;
    register_bo(bo);
    return bo;
}

struct gbm_bo *gbm_bo_create(struct gbm_device *gbm,
                             uint32_t width, uint32_t height,
                             uint32_t format, uint32_t flags) {
    return bo_create(gbm, width, height, format, flags,
                     usage_wants_gpu_tier(flags), 0);
}

/* Every bo is a single linear plane, so a modifier list is satisfiable
 * when it names LINEAR or leaves the layout implicit (INVALID). */
static int modifiers_allow_linear(const uint64_t *modifiers, unsigned count) {
    for (unsigned i = 0; i < count; i++) {
        if (modifiers[i] == DRM_FORMAT_MOD_LINEAR
            || modifiers[i] == DRM_FORMAT_MOD_INVALID)
            return 1;
    }
    return 0;
}

/* Match the public GBM pointer/count and explicit-layout contract for
 * both BOs and surfaces. USE_LINEAR cannot accompany an explicit list,
 * even if that list includes LINEAR. Never allocate a different layout
 * after the caller supplied only unsupported modifiers. */
static int modifier_request_valid(const uint64_t *modifiers, unsigned count, uint32_t flags) {
    return !((count && !modifiers) || (modifiers && !count))
        && !(modifiers && (flags & GBM_BO_USE_LINEAR))
        && (!count || modifiers_allow_linear(modifiers, count));
}

struct gbm_bo *gbm_bo_create_with_modifiers2(struct gbm_device *gbm,
                                             uint32_t width, uint32_t height,
                                             uint32_t format,
                                             const uint64_t *modifiers,
                                             const unsigned int count,
                                             uint32_t flags) {
    if (!modifier_request_valid(modifiers, count, flags)) {
        errno = EINVAL;
        return NULL;
    }
    return bo_create(gbm, width, height, format, flags,
                     modifier_usage_wants_gpu_tier(flags), 0);
}

struct gbm_bo *gbm_bo_create_with_modifiers(struct gbm_device *gbm,
                                            uint32_t width, uint32_t height,
                                            uint32_t format,
                                            const uint64_t *modifiers,
                                            const unsigned int count) {
    return gbm_bo_create_with_modifiers2(gbm, width, height, format,
                                         modifiers, count,
                                         GBM_BO_USE_SCANOUT | GBM_BO_USE_RENDERING);
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
    if (!retain_device(gbm)) return NULL;

    /* Allocate before import: a failed userspace allocation must not close
     * a cached handle still owned by another public BO. */
    struct gbm_bo *bo = calloc(1, sizeof *bo);
    if (!bo) { release_device(gbm); errno = ENOMEM; return NULL; }
    struct drm_prime_handle req = {.fd = d->fd};
    pthread_mutex_lock(&handle_mutex);
    if (drmIoctl(gbm->fd, DRM_IOCTL_PRIME_FD_TO_HANDLE, &req) < 0) {
        int save = errno;
        pthread_mutex_unlock(&handle_mutex);
        free(bo);
        release_device(gbm);
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
    bo->handle_next = live_bos;
    live_bos = bo;
    pthread_mutex_unlock(&handle_mutex);
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

int gbm_bo_get_fd_for_plane(struct gbm_bo *bo, int plane) {
    if (plane != 0) {
        errno = EINVAL;
        return -1;
    }
    return gbm_bo_get_fd(bo);
}

/* Caller holds mapping_mutex. Map the canonical BO once so overlapping
 * CPU views alias the same bytes until the final view is released. */
static int map_bo_locked(struct gbm_bo *bo) {
    if (bo->map_addr) return 0;
    if (bo->size > SIZE_MAX) { errno = EOVERFLOW; return -1; }
    struct drm_mode_map_dumb req = {.handle = bo->handle};
    if (drmIoctl(bo->dev->fd, DRM_IOCTL_MODE_MAP_DUMB, &req) < 0) return -1;
    void *addr = mmap(NULL, (size_t)bo->size, PROT_READ | PROT_WRITE,
        MAP_SHARED, bo->dev->fd, (off_t)req.offset);
    if (addr == MAP_FAILED) return -1;
    bo->map_addr = addr;
    bo->map_len = (size_t)bo->size;
    return 0;
}

void *gbm_bo_map(struct gbm_bo *bo,
                 uint32_t x, uint32_t y, uint32_t width, uint32_t height,
                 uint32_t flags, uint32_t *stride, void **map_data) {
    if (!bo || !stride || !map_data || !width || !height || bo->is_gpu ||
        (flags & ~GBM_BO_TRANSFER_READ_WRITE) || x >= bo->width || y >= bo->height ||
        width > bo->width - x || height > bo->height - y) {
        errno = EINVAL;
        return NULL;
    }
    uint64_t x_bytes = (uint64_t)x * (bo->bpp / 8);
    uint64_t row_bytes = (uint64_t)width * (bo->bpp / 8);
    if (x_bytes + row_bytes > bo->stride ||
        ((uint64_t)y + height - 1) * bo->stride + x_bytes + row_bytes > bo->size) {
        errno = EINVAL;
        return NULL;
    }
    struct gbm_mapping *mapping = calloc(1, sizeof *mapping);
    if (!mapping) { errno = ENOMEM; return NULL; }
    pthread_mutex_lock(&mapping_mutex);
    if (!next_mapping_token || map_bo_locked(bo) < 0) {
        if (!next_mapping_token) errno = ENOMEM;
        pthread_mutex_unlock(&mapping_mutex);
        free(mapping);
        return NULL;
    }
    /* Tokens are never recycled, even if malloc reuses a record address.
     * A stale or foreign map_data must not release another live mapping. */
    mapping->token = next_mapping_token++;
    mapping->next = bo->mappings;
    bo->mappings = mapping;
    /* A failed private write release has no public token owner. The new
     * lease keeps the same mapping alive while retiring that bookkeeping;
     * its final release retries the actual unmap instead of leaking a hold. */
    struct gbm_mapping **pending = &mapping->next;
    while (*pending) {
        if ((*pending)->internal_release_pending) {
            struct gbm_mapping *retired = *pending;
            *pending = retired->next;
            free(retired);
        } else pending = &(*pending)->next;
    }
    void *address = (char *)bo->map_addr + (size_t)((uint64_t)y * bo->stride + x_bytes);
    *stride = bo->stride;
    *map_data = (void *)mapping->token;
    pthread_mutex_unlock(&mapping_mutex);
    return address;
}

static int unmap_bo_locked(struct gbm_bo *bo, void *map_data) {
    struct gbm_mapping **link = &bo->mappings;
    while (*link && (*link)->token != (uintptr_t)map_data) link = &(*link)->next;
    if (!*link) { errno = EINVAL; return -1; }
    struct gbm_mapping *mapping = *link;
    if (link == &bo->mappings && !mapping->next) {
        // Keep the lease and address if the kernel did not accept release.
        if (munmap(bo->map_addr, bo->map_len) < 0) return -1;
        bo->map_addr = NULL;
        bo->map_len = 0;
    }
    *link = mapping->next;
    free(mapping);
    return 0;
}

void gbm_bo_unmap(struct gbm_bo *bo, void *map_data) {
    if (!bo) { errno = EINVAL; return; }
    pthread_mutex_lock(&mapping_mutex);
    unmap_bo_locked(bo, map_data);
    pthread_mutex_unlock(&mapping_mutex);
}

void gbm_bo_destroy(struct gbm_bo *bo) {
    if (!bo) return;
    if (bo->user_data_destroy) {
        bo->user_data_destroy(bo, bo->user_data);
        bo->user_data = NULL;
        bo->user_data_destroy = NULL;
    }
    pthread_mutex_lock(&mapping_mutex);
    if (bo->map_addr) munmap(bo->map_addr, bo->map_len);
    while (bo->mappings) {
        struct gbm_mapping *mapping = bo->mappings;
        bo->mappings = mapping->next;
        free(mapping);
    }
    pthread_mutex_unlock(&mapping_mutex);
    pthread_mutex_lock(&handle_mutex);
    struct gbm_bo **link = &live_bos;
    while (*link && *link != bo) link = &(*link)->handle_next;
    if (*link) *link = bo->handle_next;
    int retained = 0;
    for (struct gbm_bo *peer = live_bos; peer; peer = peer->handle_next) {
        if (peer->dev == bo->dev && peer->handle == bo->handle) {
            retained = 1;
            break;
        }
    }
    if (!retained) drmCloseBufferHandle(bo->dev->fd, bo->handle);
    pthread_mutex_unlock(&handle_mutex);
    release_device(bo->dev);
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
    uint32_t stride;
    void *token;
    void *address = gbm_bo_map(bo, 0, 0, bo->width, bo->height,
        GBM_BO_TRANSFER_WRITE, &stride, &token);
    if (!address) return -1;
    memcpy(address, buf, count);
    pthread_mutex_lock(&mapping_mutex);
    int result = unmap_bo_locked(bo, token);
    if (result < 0) {
        for (struct gbm_mapping *mapping = bo->mappings; mapping; mapping = mapping->next) {
            if (mapping->token == (uintptr_t)token) {
                mapping->internal_release_pending = 1;
                break;
            }
        }
    }
    pthread_mutex_unlock(&mapping_mutex);
    return result;
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

/* Every BO the kernel's CREATE_DUMB path produces is a single linear
 * plane, so the per-plane accessors collapse onto the whole-BO ones.
 * SDL2's KMSDRM backend walks planes to build its drmModeAddFB2 call. */

int gbm_bo_get_plane_count(struct gbm_bo *bo) {
    (void) bo;
    return 1;
}

union gbm_bo_handle gbm_bo_get_handle_for_plane(struct gbm_bo *bo, int plane) {
    union gbm_bo_handle h;
    h.u32 = plane == 0 ? bo->handle : 0;
    return h;
}

uint32_t gbm_bo_get_stride_for_plane(struct gbm_bo *bo, int plane) {
    return plane == 0 ? bo->stride : 0;
}

uint32_t gbm_bo_get_offset(struct gbm_bo *bo, int plane) {
    (void) bo; (void) plane;
    return 0;
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

/* The initial CPU-compatible allocation preserves constructor validation.
 * EGL acquires strict GPU render storage transactionally before it can use
 * the window; no CPU BO is ever published as a rendered front. */
static struct gbm_bo *surface_alloc_bo(struct gbm_surface *s, int gpu) {
    struct gbm_bo *bo = bo_create(s->dev, s->width, s->height,
                                s->format, s->flags, gpu, 1);
    if (bo) bo->surface = s;
    return bo;
}

struct gbm_surface *gbm_surface_create(struct gbm_device *gbm,
                                       uint32_t width, uint32_t height,
                                       uint32_t format, uint32_t flags) {
    if (!gbm || !width || !height || !format_bpp(format)) {
        errno = EINVAL;
        return NULL;
    }
    if (!retain_device(gbm)) return NULL;
    struct gbm_surface *s = (struct gbm_surface *) calloc(1, sizeof(*s));
    if (!s) {
        release_device(gbm);
        errno = ENOMEM;
        return NULL;
    }
    s->dev    = gbm;
    s->width  = width;
    s->height = height;
    s->format = format;
    s->flags  = flags;
    s->public_live = 1;
    s->back = s->front = s->pending = -1;
    for (int i = 0; i < WPK_GBM_SURFACE_INITIAL_BO_COUNT; i++) {
        s->bos[i] = surface_alloc_bo(s, usage_wants_gpu_tier(flags));
        if (!s->bos[i]) {
            int save = errno;
            for (int j = 0; j < i; j++) {
                s->bos[j]->surface = NULL;
                gbm_bo_destroy(s->bos[j]);
            }
            free(s);
            release_device(gbm);
            errno = save;
            return NULL;
        }
    }
    pthread_mutex_lock(&surface_mutex);
    s->live_next = live_surfaces;
    live_surfaces = s;
    pthread_mutex_unlock(&surface_mutex);
    return s;
}

struct gbm_surface *
gbm_surface_create_with_modifiers(struct gbm_device *gbm,
                                  uint32_t width, uint32_t height,
                                  uint32_t format,
                                  const uint64_t *modifiers,
                                  const unsigned int count) {
    return gbm_surface_create_with_modifiers2(gbm, width, height, format,
        modifiers, count, GBM_BO_USE_SCANOUT | GBM_BO_USE_RENDERING);
}

struct gbm_surface *
gbm_surface_create_with_modifiers2(struct gbm_device *gbm,
                                   uint32_t width, uint32_t height,
                                   uint32_t format,
                                   const uint64_t *modifiers,
                                   const unsigned int count,
                                   uint32_t flags) {
    if (!modifier_request_valid(modifiers, count, flags)) {
        errno = EINVAL;
        return NULL;
    }
    return gbm_surface_create(gbm, width, height, format, flags);
}

/* Every lookup compares opaque pointers before dereferencing them. Retired
 * public windows remain in this owner table while EGL/locked fronts hold them. */
static struct gbm_surface *find_surface_locked(const void *window) {
    for (struct gbm_surface *s = live_surfaces; s; s = s->live_next)
        if (s == window) return s;
    return NULL;
}
static struct gbm_surface *retire_surface_locked(struct gbm_surface *s) {
    if (s->public_live || s->window_owned) return NULL;
    for (unsigned i = 0; i < WPK_GBM_SURFACE_BO_COUNT; ++i)
        if (s->in_use[i]) return NULL;
    struct gbm_surface **link = &live_surfaces;
    while (*link && *link != s) link = &(*link)->live_next;
    if (*link) *link = s->live_next;
    return s;
}
/* User BO callbacks may reenter EGL/GBM. Never run them under metadata locks. */
static void free_surface(struct gbm_surface *s) {
    if (!s) return;
    for (unsigned i = 0; i < WPK_GBM_SURFACE_BO_COUNT; ++i) {
        if (s->bos[i]) {
            s->bos[i]->surface = NULL;
            gbm_bo_destroy(s->bos[i]);
        }
    }
    release_device(s->dev);
    free(s);
}
static void surface_frame(struct gbm_surface *s, int index, struct wpk_gbm_frame *frame) {
    *frame = (struct wpk_gbm_frame){s->dev->fd, s->bos[index]->handle, s->width, s->height};
}
int _wpk_gbm_window_acquire(const void *window, void **lease, struct wpk_gbm_frame *frame) {
    struct gbm_bo *replaced[WPK_GBM_SURFACE_BO_COUNT] = {0};
    int accepted = 0;
    pthread_mutex_lock(&surface_mutex);
    struct gbm_surface *s = find_surface_locked(window);
    if (!s || !s->public_live) errno = EINVAL;
    else if (s->window_owned) errno = EBUSY;
    else if (!(s->flags & GBM_BO_USE_RENDERING) ||
             (s->flags & (GBM_BO_USE_WRITE | GBM_BO_USE_LINEAR | GBM_BO_USE_CURSOR)))
        errno = EOPNOTSUPP;
    else {
        /* Pick any unlocked slot. Replacing an unexposed CPU allocation is
         * safe; failure leaves every existing slot and owner unchanged. */
        errno = EBUSY;
        for (int i = 0; i < WPK_GBM_SURFACE_BO_COUNT; ++i) {
            if (s->in_use[i]) continue;
            struct gbm_bo *bo = s->bos[i];
            if (!bo || !bo->is_gpu) {
                bo = surface_alloc_bo(s, 2);
                if (!bo) break;
                replaced[i] = s->bos[i];
                s->bos[i] = bo;
            }
            s->back = i;
            s->front = s->pending = -1;
            s->window_owned = 1;
            surface_frame(s, i, frame);
            *lease = s;
            accepted = 1;
            break;
        }
        if (!accepted && !errno) errno = EBUSY;
    }
    pthread_mutex_unlock(&surface_mutex);
    for (unsigned i = 0; i < WPK_GBM_SURFACE_BO_COUNT; ++i)
        if (replaced[i]) { replaced[i]->surface = NULL; gbm_bo_destroy(replaced[i]); }
    return accepted;
}
int _wpk_gbm_window_prepare(void *lease, struct wpk_gbm_frame *frame) {
    int accepted = 0;
    struct gbm_bo *replaced = NULL;
    pthread_mutex_lock(&surface_mutex);
    struct gbm_surface *s = find_surface_locked(lease);
    if (!s || !s->window_owned || s->pending >= 0) errno = EINVAL;
    else {
        errno = EBUSY;
        for (int i = 0; i < WPK_GBM_SURFACE_BO_COUNT; ++i) {
            if (i == s->back || i == s->front || s->in_use[i]) continue;
            struct gbm_bo *bo = s->bos[i];
            if (!bo || !bo->is_gpu) {
                /* CPU allocations have never escaped through lock_front. */
                bo = surface_alloc_bo(s, 2);
                if (!bo) break;
                replaced = s->bos[i];
                s->bos[i] = bo;
            }
            s->pending = i;
            surface_frame(s, i, frame);
            accepted = 1;
            break;
        }
    }
    pthread_mutex_unlock(&surface_mutex);
    if (replaced) { replaced->surface = NULL; gbm_bo_destroy(replaced); }
    return accepted;
}
void _wpk_gbm_window_finish(void *lease, int accepted) {
    pthread_mutex_lock(&surface_mutex);
    struct gbm_surface *s = find_surface_locked(lease);
    if (s && s->window_owned && s->pending >= 0) {
        if (accepted) { s->front = s->back; s->back = s->pending; }
        s->pending = -1;
    }
    pthread_mutex_unlock(&surface_mutex);
}
void _wpk_gbm_window_release(void *lease) {
    pthread_mutex_lock(&surface_mutex);
    struct gbm_surface *s = find_surface_locked(lease), *retired = NULL;
    if (s && s->window_owned) {
        s->window_owned = 0;
        s->back = s->front = s->pending = -1;
        retired = retire_surface_locked(s);
    }
    pthread_mutex_unlock(&surface_mutex);
    free_surface(retired);
}
struct gbm_bo *gbm_surface_lock_front_buffer(struct gbm_surface *window) {
    struct gbm_bo *bo = NULL;
    pthread_mutex_lock(&surface_mutex);
    struct gbm_surface *s = find_surface_locked(window);
    if (s && s->public_live && s->front >= 0) {
        int index = s->front;
        s->front = -1;
        s->in_use[index] = 1;
        bo = s->bos[index];
    } else errno = EINVAL;
    pthread_mutex_unlock(&surface_mutex);
    return bo;
}
void gbm_surface_release_buffer(struct gbm_surface *window, struct gbm_bo *bo) {
    pthread_mutex_lock(&surface_mutex);
    struct gbm_surface *s = find_surface_locked(window), *retired = NULL;
    if (s && bo) {
        for (unsigned i = 0; i < WPK_GBM_SURFACE_BO_COUNT; ++i)
            if (s->bos[i] == bo) { s->in_use[i] = 0; break; }
        retired = retire_surface_locked(s);
    }
    pthread_mutex_unlock(&surface_mutex);
    free_surface(retired);
}
int gbm_surface_has_free_buffers(struct gbm_surface *window) {
    int available = 0;
    pthread_mutex_lock(&surface_mutex);
    struct gbm_surface *s = find_surface_locked(window);
    if (s && s->public_live)
        for (unsigned i = 0; i < WPK_GBM_SURFACE_BO_COUNT; ++i)
            if (!s->in_use[i] && (int)i != s->back && (int)i != s->front) { available = 1; break; }
    pthread_mutex_unlock(&surface_mutex);
    return available;
}
void gbm_surface_destroy(struct gbm_surface *window) {
    pthread_mutex_lock(&surface_mutex);
    struct gbm_surface *s = find_surface_locked(window), *retired = NULL;
    if (s && s->public_live) { s->public_live = 0; retired = retire_surface_locked(s); }
    pthread_mutex_unlock(&surface_mutex);
    free_surface(retired);
}
