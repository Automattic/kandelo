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
 * The surface holds a fixed-size two-BO ring (double-buffer);
 * lock_front_buffer hands out an unused BO and release_buffer
 * returns it. Modifier requests must allow a linear layout; unsupported
 * lists fail before allocation. Full rendered front/back storage remains
 * separate from this ring bookkeeping.
 *
 * Format queries report the single linear plane actually allocated here;
 * names use the public fourcc spelling, including the two legacy aliases.
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
    int fd;  /* owned by caller; gbm_device_destroy does NOT close it */
    uint64_t identity;
    struct gbm_device *live_next;
};

static pthread_mutex_t device_mutex = PTHREAD_MUTEX_INITIALIZER;
static struct gbm_device *live_devices;
static uint64_t next_device_identity = 1;

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
};

struct gbm_mapping {
    struct gbm_mapping *next;
    uintptr_t token;
    int internal_release_pending;
};
static pthread_mutex_t mapping_mutex = PTHREAD_MUTEX_INITIALIZER;
static uintptr_t next_mapping_token = 1;

#define WPK_GBM_SURFACE_BO_COUNT 2

struct gbm_surface {
    struct gbm_device *dev;
    uint32_t width, height;
    uint32_t format;
    uint32_t flags;
    struct gbm_bo *bos[WPK_GBM_SURFACE_BO_COUNT];
    int in_use[WPK_GBM_SURFACE_BO_COUNT];
    int next;                /* round-robin cursor for lock_front_buffer */
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
        if (s == window) {
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
    d->fd = fd;
    pthread_mutex_lock(&device_mutex);
    if (next_device_identity == 0) {
        pthread_mutex_unlock(&device_mutex);
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
    pthread_mutex_lock(&device_mutex);
    struct gbm_device **slot = &live_devices;
    while (*slot && *slot != gbm) slot = &(*slot)->live_next;
    if (*slot) {
        *slot = gbm->live_next;
        free(gbm);
    }
    pthread_mutex_unlock(&device_mutex);
}

int gbm_device_get_fd(struct gbm_device *gbm) {
    return gbm->fd;
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
                                int gpu_tier) {
    uint32_t bpp = format_bpp(format);
    if (!gbm || !bpp || !width || !height) {
        errno = EINVAL;
        return NULL;
    }

    struct gbm_bo *bo = (struct gbm_bo *) calloc(1, sizeof(*bo));
    if (!bo) {
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
            return bo;
        }
        /* else: degrade to CPU tier below. */
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
        errno = save;
        return NULL;
    }
    bo->handle = req.handle;
    bo->stride = req.pitch;
    bo->size   = req.size;
    return bo;
}

struct gbm_bo *gbm_bo_create(struct gbm_device *gbm,
                             uint32_t width, uint32_t height,
                             uint32_t format, uint32_t flags) {
    return bo_create(gbm, width, height, format, flags,
                     usage_wants_gpu_tier(flags));
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
                     modifier_usage_wants_gpu_tier(flags));
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
    pthread_mutex_lock(&surface_mutex);
    struct gbm_surface **link = &live_surfaces;
    while (*link && *link != surface) link = &(*link)->live_next;
    if (*link) *link = surface->live_next;
    pthread_mutex_unlock(&surface_mutex);
    for (int i = 0; i < WPK_GBM_SURFACE_BO_COUNT; i++) {
        if (surface->bos[i]) {
            surface->bos[i]->surface = NULL;
            gbm_bo_destroy(surface->bos[i]);
            surface->bos[i] = NULL;
        }
    }
    free(surface);
}
