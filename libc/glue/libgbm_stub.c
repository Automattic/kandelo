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
 *   - gbm_device_is_format_supported (scanout fourccs; per-usage planes)
 *   - gbm_bo_create        (linear; R8, GR88, RGB565, 8888, 2101010,
 *                           16161616F, and NV12/NV21/YUV420/YVU420/YUYV/
 *                           UYVY/P010 in one CPU object: see k_formats)
 *   - gbm_bo_create_with_modifiers / gbm_bo_create_with_modifiers2
 *                          (LINEAR or implicit modifiers only)
 *   - gbm_bo_destroy
 *   - gbm_bo_get_fd        (PRIME export → handle-to-fd)
 *   - gbm_bo_import        (GBM_BO_IMPORT_FD for one plane, and
 *                           GBM_BO_IMPORT_FD_MODIFIER for every linear plane
 *                           of the format: fd-to-handle, each bounded by its
 *                           dma-buf's real size; GBM_BO_IMPORT_EGL_IMAGE
 *                           for an image of this device's EGL display)
 *   - gbm_bo_map / gbm_bo_unmap   (mmap of the first plane)
 *   - gbm_bo_write         (map + memcpy)
 *   - gbm_bo_set/get_user_data (opaque pointer with destroy cb)
 *   - accessors: get_width / get_height / get_stride / get_format
 *                / get_bpp / get_modifier / get_handle / get_device
 *   - per-plane accessors: get_plane_count / get_offset /
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
 * Format queries report the linear planes actually allocated here.
 * Every entry point canonicalizes the legacy GBM_BO_FORMAT_XRGB8888/ARGB8888
 * values to their fourcc, as Mesa does, and only fourccs are reported.
 */

#include <gbm.h>
#include "gbm_window.h"
#include "drm_owned.h"
#include "drm_format_info.h"
#include <drm/drm.h>
#include <drm/drm_mode.h>
#include <drm/drm_fourcc.h>
#include <sys/mman.h>
#include <fcntl.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <limits.h>

/* libEGL's half of GBM_BO_IMPORT_EGL_IMAGE; absent when EGL is not linked,
 * which leaves no EGLImage to import. */
__attribute__((weak)) int _wpk_egl_image_export_gbm(const void *, const void *, uint64_t,
                                                    struct wpk_gbm_image *);
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

/* WPK_CHECK_BO_FORMAT (mirrors wasm_posix_shared::dri): EINVAL when a
 * GPU-tier bo's texture storage cannot be named by `format`. */
#define WPK_DRM_IOCTL_CHECK_BO_FORMAT 0xc00864e4u  /* _IOWR('d', 0xE4, 8) */
struct wpk_drm_check_bo_format { uint32_t handle, format; };

/* Kernel capabilities retain the exact open description. A real alias is
 * exposed only by APIs which promise a descriptor; rendering and cleanup do
 * not consult that recyclable name. BO capabilities independently retain
 * storage even if a caller closes its public GEM handle through another fd. */
struct gbm_device {
    struct wpk_drm_owner *owner;
    int fd, public_fd;
    unsigned references;
    uint64_t identity;
    struct gbm_device *live_next;
};

static struct wpk_drm_mutex device_mutex = WPK_DRM_MUTEX_INITIALIZER;
static struct gbm_device *live_devices;
static uint64_t next_device_identity = 1;

static int retain_device(struct gbm_device *device) {
    int retained = 0;
    _wpk_drm_mutex_lock(&device_mutex);
    for (struct gbm_device *p = live_devices; p; p = p->live_next) {
        if (p == device && p->references != UINT_MAX) {
            ++p->references;
            retained = 1;
            break;
        }
    }
    _wpk_drm_mutex_unlock(&device_mutex);
    if (!retained) errno = EINVAL;
    return retained;
}

static int retain_owned_device(struct gbm_device *device) {
    _wpk_drm_mutex_lock(&device_mutex);
    int retained = device->references != UINT_MAX;
    if (retained) ++device->references;
    _wpk_drm_mutex_unlock(&device_mutex);
    if (!retained) errno = EOVERFLOW;
    return retained;
}

/* Public withdrawal cannot invalidate BOs or windows. Their independent
 * C holds keep the exact kernel file capability until final retirement. */
/* device_mutex and the common publication guard are held. The last C
 * device edge moves to globally visible exact custody before its facade can
 * disappear, including when the edge belongs to a BO or window ring. */
static int release_device_published(struct gbm_device *device) {
    if(!device->references)abort();
    int retired=--device->references==0;
    if(retired)_wpk_drm_owned_defer_locked(&device->owner);
    return retired;
}
static void release_device(struct gbm_device *device) {
    int cancel_state;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&cancel_state);
    _wpk_drm_mutex_lock(&device_mutex);
    _wpk_drm_owned_publication_begin();
    int retired=release_device_published(device);
    _wpk_drm_owned_publication_end();
    _wpk_drm_mutex_unlock(&device_mutex);
    if(retired){free(device);_wpk_drm_owned_drain();}
    pthread_setcancelstate(cancel_state,NULL);
}

/* EGL receives an opaque native handle. Resolve only our live devices;
 * neither a foreign pointer nor a recycled allocation selects an old display. */
int _wpk_gbm_device_metadata(const void *native, int *fd, uint64_t *identity) {
    int found = 0;
    _wpk_drm_mutex_lock(&device_mutex);
    for (struct gbm_device *d = live_devices; d; d = d->live_next) {
        if (d == native) {
            *fd = d->fd;
            *identity = d->identity;
            found = 1;
            break;
        }
    }
    _wpk_drm_mutex_unlock(&device_mutex);
    return found;
}

int _wpk_gbm_device_acquire_fd(const void *native, uint64_t identity) {
    int fd = -1;
    _wpk_drm_mutex_lock(&device_mutex);
    errno = EINVAL;
    for (struct gbm_device *d = live_devices; d; d = d->live_next) {
        if (d == native && d->identity == identity) {
            fd = _wpk_drm_owned_fd(d->owner,-1,O_CLOEXEC);
            break;
        }
    }
    _wpk_drm_mutex_unlock(&device_mutex);
    return fd;
}

int _wpk_gbm_device_acquire_owner(const void *native,uint64_t identity,struct wpk_drm_owner **owner) {
    if(!owner){errno=EINVAL;return -1;}*owner=NULL;
    _wpk_drm_mutex_lock(&device_mutex);int rc=-1;errno=EINVAL;
    for(struct gbm_device *d=live_devices;d;d=d->live_next)if(d==native&&d->identity==identity){
        rc=_wpk_drm_owned_retain(d->owner);if(!rc)*owner=d->owner;break;
    }
    _wpk_drm_mutex_unlock(&device_mutex);return rc;
}

struct gbm_bo {
    struct gbm_device *dev;
    uint32_t handle;          /* per-fd DRM handle */
    uint32_t width, height;
    uint32_t stride;          /* pitch in bytes */
    uint32_t format;          /* fourcc */
    uint32_t bpp;             /* bits per pixel; 0 for YUV (as Mesa reports) */
    uint32_t cpp;             /* bytes per sample of plane 0 */
    uint64_t size;            /* bytes of the CPU view from `offset`: plane 0
                               * (pitch * height), or every plane of a buffer
                               * gbm_bo_create laid out in one object */
    uint32_t offset;          /* plane start within the dma-buf (imports only) */
    /* Every plane (drm_format_info.h); plane 0 repeats handle/stride/offset.
     * A plane's object may be another plane's or its own. */
    unsigned plane_count;
    struct { uint32_t handle, stride, offset; struct wpk_drm_owner *owner; } planes[GBM_MAX_PLANES];
    uint64_t modifier;        /* DRM_FORMAT_MOD_LINEAR for v1 */
    int is_gpu;               /* 1 = GPU-tier (unmappable WebGLTexture bo) */
    struct gbm_mapping *mappings;
    void *map_addr;           /* shared by this BO's active CPU map leases */
    size_t map_len;
    struct wpk_drm_mapping mapping;
    void *user_data;
    void (*user_data_destroy)(struct gbm_bo *, void *);
    struct wpk_drm_actor_claim callback_claim, destruction_claim;
    int callback_started, retiring;
    uint64_t drain_visit_nonce;
    struct gbm_bo *retirement_next;
    struct gbm_surface *surface;  /* non-NULL when owned by a surface ring */
    struct gbm_bo *handle_next;
};

/* Metadata registration is independent of kernel storage custody. Each
 * imported plane has a capability before registration, so removing a peer
 * cannot revoke an accepted allocation or a later recycled numeric name. */
static struct wpk_drm_mutex handle_mutex = WPK_DRM_MUTEX_INITIALIZER;
static struct gbm_bo *live_bos, *retired_bos;
static struct wpk_drm_actor_claim bo_drain_claim;
static _Atomic int bo_retire_pending;
static void drain_retired_bos(void);
static void drain_retired_surfaces(void);
static void register_bo(struct gbm_bo *bo) {
    _wpk_drm_mutex_lock(&handle_mutex);
    bo->handle_next = live_bos;
    live_bos = bo;
    _wpk_drm_mutex_unlock(&handle_mutex);
}

struct gbm_mapping {
    struct gbm_mapping *next;
    uintptr_t token;
    int internal_release_pending;
};
static struct wpk_drm_mutex mapping_mutex = WPK_DRM_MUTEX_INITIALIZER;
static uintptr_t next_mapping_token = 1;

#define WPK_GBM_SURFACE_BO_COUNT 4
#define WPK_GBM_SURFACE_INITIAL_BO_COUNT 2

struct gbm_surface {
    struct gbm_device *dev;
    uint32_t width, height, format, flags;
    struct gbm_bo *bos[WPK_GBM_SURFACE_BO_COUNT];
    int in_use[WPK_GBM_SURFACE_BO_COUNT];
    int public_live, window_owned, device_retired;
    struct wpk_drm_actor_claim retirement_claim;
    uint64_t drain_visit_nonce;
    struct gbm_surface *retirement_next;
    int back, front, pending;
    struct gbm_surface *live_next;
};

/* EGL native windows are opaque. Look up our own live handles rather than
 * interpreting another backend's pointer using the GBM structure layout. */
static struct wpk_drm_mutex surface_mutex = WPK_DRM_MUTEX_INITIALIZER;
static struct gbm_surface *live_surfaces, *retired_surfaces;
static struct wpk_drm_actor_claim surface_drain_claim;
static _Atomic int surface_retire_pending;

int _wpk_gbm_surface_metadata(const void *window, uint32_t *width, uint32_t *height,
                              uint32_t *format, uint32_t *flags) {
    int found = 0;
    _wpk_drm_mutex_lock(&surface_mutex);
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
    _wpk_drm_mutex_unlock(&surface_mutex);
    return found;
}
int _wpk_gbm_surface_dimensions(const void *window, uint32_t *width, uint32_t *height) {
    uint32_t format, flags;
    return _wpk_gbm_surface_metadata(window, width, height, &format, &flags);
}

/* The formats a Kandelo buffer holds, and the planes and windows that can
 * use them. Each format's memory layout (planes, bytes per sample,
 * subsampling) comes from drm_format_info.h, the table the kernel, libEGL
 * and the host share.
 * - scanout: the KMS primary plane scans it out (kms::PRIMARY_PLANE_FORMATS;
 *   10-bit and half-float planes reduced to the 8-bpc output).
 * - window: an EGL window surface can render to it. Kandelo's EGL configs
 *   name 32-bpp 8888 windows, whose fronts are RGBA8 renders.
 * - render: a GL render target. Every RGB format is one in both tiers:
 *   GPU-tier storage is a WebGL 2 texture of the format's own internal
 *   format (R8, RG8, RGB565, RGBA8, RGB10_A2, RGBA16F; the kernel's
 *   gpu_storage_format_cpp lists the same set), and a CPU-tier buffer
 *   imported as an EGLImage is mirrored in that same texture format with
 *   an exact byte conversion each way. A YUV buffer is sampled only: EGL
 *   imports it as an external image converted to RGBA when its bytes
 *   change, and no texture format stores YUV planes to render into.
 * CREATE_DUMB accepts any bpp, so every format has CPU-tier (dumb) storage;
 * a YUV buffer is one dumb object holding all of its planes. */
struct wpk_gbm_format { uint32_t fourcc; int scanout, window, render; };
static const struct wpk_gbm_format k_formats[] = {
    {DRM_FORMAT_R8, 1, 0, 1},
    {DRM_FORMAT_GR88, 1, 0, 1},
    {DRM_FORMAT_RGB565, 1, 0, 1},
    {DRM_FORMAT_XRGB8888, 1, 1, 1},
    {DRM_FORMAT_ARGB8888, 1, 1, 1},
    {DRM_FORMAT_XBGR8888, 1, 1, 1},
    {DRM_FORMAT_ABGR8888, 1, 1, 1},
    {DRM_FORMAT_XRGB2101010, 1, 0, 1},
    {DRM_FORMAT_ARGB2101010, 1, 0, 1},
    {DRM_FORMAT_XBGR2101010, 1, 0, 1},
    {DRM_FORMAT_ABGR2101010, 1, 0, 1},
    {DRM_FORMAT_XBGR16161616F, 1, 0, 1},
    {DRM_FORMAT_ABGR16161616F, 1, 0, 1},
    {DRM_FORMAT_NV12, 0, 0, 0},
    {DRM_FORMAT_NV21, 0, 0, 0},
    {DRM_FORMAT_YUV420, 0, 0, 0},
    {DRM_FORMAT_YVU420, 0, 0, 0},
    {DRM_FORMAT_YUYV, 0, 0, 0},
    {DRM_FORMAT_UYVY, 0, 0, 0},
    {DRM_FORMAT_P010, 0, 0, 0},
};

static const struct wpk_gbm_format *format_info(uint32_t fourcc) {
    for (unsigned i = 0; i < sizeof k_formats / sizeof k_formats[0]; i++)
        if (k_formats[i].fourcc == fourcc) return &k_formats[i];
    return NULL;
}

/* The memory layout of a format a Kandelo buffer holds, or NULL. */
static const struct wpk_drm_format_info *format_layout(uint32_t fourcc) {
    return format_info(fourcc) ? wpk_drm_format_info(fourcc) : NULL;
}

/* Mesa's gbm_bo_get_bpp: bits per pixel of a packed RGB format; YUV has no
 * single value and reports 0. */
static uint32_t layout_bpp(const struct wpk_drm_format_info *layout) {
    return layout->is_yuv ? 0 : layout->cpp[0] * 8;
}

/* A buffer of a sample-only (YUV) format is no render target, cursor or
 * scanout buffer. */
static int usage_serves_format(const struct wpk_gbm_format *info, uint32_t flags) {
    if ((flags & GBM_BO_USE_SCANOUT) && !info->scanout) return 0;
    if ((flags & (GBM_BO_USE_RENDERING | GBM_BO_USE_CURSOR)) && !info->render) return 0;
    return 1;
}

/* A gbm_surface exists to back an EGL window surface. */
static int format_surface(uint32_t fourcc) {
    const struct wpk_gbm_format *info = format_info(fourcc);
    return info && info->window;
}

/* Usages Kandelo can provide. Protected content and fixed-rate compression
 * have no implementation here, so they fail with EINVAL like unknown bits
 * instead of being granted in name only.
 *
 * GBM_BO_USE_FRONT_RENDERING (Mesa's DRI backend passes it on as
 * __DRI_IMAGE_USE_FRONT_RENDERING, which drivers honor by disabling
 * framebuffer compression) asks that rendering into a buffer being scanned
 * out stay in step with the scanned-out pixels. No Kandelo buffer has
 * compression metadata, and the host presents the scanout buffer's current
 * storage on vblanks without needing a flip, so every buffer already
 * satisfies it. */
#define WPK_GBM_SUPPORTED_USAGE (GBM_BO_USE_SCANOUT | GBM_BO_USE_CURSOR | \
    GBM_BO_USE_RENDERING | GBM_BO_USE_WRITE | GBM_BO_USE_LINEAR | \
    GBM_BO_USE_FRONT_RENDERING)

static uint32_t canonical_format(uint32_t format) {
    if (format == GBM_BO_FORMAT_XRGB8888) return GBM_FORMAT_XRGB8888;
    if (format == GBM_BO_FORMAT_ARGB8888) return GBM_FORMAT_ARGB8888;
    return format;
}

int gbm_device_get_format_modifier_plane_count(struct gbm_device *gbm,
                                               uint32_t format, uint64_t modifier) {
    const struct wpk_drm_format_info *layout = format_layout(canonical_format(format));
    if (!gbm || !layout || modifier != DRM_FORMAT_MOD_LINEAR) {
        errno = EINVAL;
        return -1;
    }
    return (int)layout->num_planes;
}

char *gbm_format_get_name(uint32_t format, struct gbm_format_name_desc *desc) {
    format = canonical_format(format);
    for (unsigned i = 0; i < 4; ++i) desc->name[i] = (char)(format >> (i * 8));
    desc->name[4] = '\0';
    return desc->name;
}

static struct gbm_device *publish_owned_device(struct wpk_drm_owner *owner,int public_fd) {
    struct gbm_device *d=calloc(1,sizeof *d);if(!d)return NULL;
    if(_wpk_drm_owned_retain(owner)!=0){free(d);return NULL;}
    d->owner=owner;
    d->fd=_wpk_drm_owned_fd(d->owner,-1,O_CLOEXEC|WPK_DRM_OWNED_BORROW_ALIAS);
    if(d->fd<0){_wpk_drm_owned_retire(&d->owner);free(d);return NULL;}
    _wpk_drm_mutex_lock(&device_mutex);
    if(!next_device_identity){
        _wpk_drm_mutex_unlock(&device_mutex);_wpk_drm_owned_retire(&d->owner);free(d);errno=EOVERFLOW;return NULL;
    }
    d->public_fd=public_fd>=0?public_fd:d->fd;d->references=1;d->identity=next_device_identity;
    next_device_identity=next_device_identity==UINT64_MAX?0:next_device_identity+1;
    d->live_next=live_devices;live_devices=d;
    _wpk_drm_mutex_unlock(&device_mutex);return d;
}
struct gbm_device *gbm_create_device(int fd) {
    drain_retired_bos();drain_retired_surfaces();
    struct wpk_drm_owner *owner=NULL;
    if(_wpk_drm_owned_acquire(fd,0,&owner)!=0){_wpk_drm_owned_retire(&owner);return NULL;}
    struct gbm_device *device=publish_owned_device(owner,fd);_wpk_drm_owned_retire(&owner);return device;
}
struct gbm_device *_wpk_gbm_device_from_owner(struct wpk_drm_owner *owner) {
    /* Internal window allocation starts with atomic owned OPEN. Exporting a
     * raw fd and reacquiring it here would recreate the close/reuse window. */
    return publish_owned_device(owner,-1);
}

void gbm_device_destroy(struct gbm_device *gbm) {
    drain_retired_bos();drain_retired_surfaces();
    int retired=0,cancel_state;
    pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&cancel_state);
    _wpk_drm_mutex_lock(&device_mutex);
    struct gbm_device **slot = &live_devices;
    while (*slot && *slot != gbm) slot = &(*slot)->live_next;
    if (*slot) {
        _wpk_drm_owned_publication_begin();
        *slot = gbm->live_next;
        retired=release_device_published(gbm);
        _wpk_drm_owned_publication_end();
    }
    _wpk_drm_mutex_unlock(&device_mutex);
    if(retired){free(gbm);_wpk_drm_owned_drain();}
    pthread_setcancelstate(cancel_state,NULL);
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

/* Lay the planes of a YUV buffer out in one object, as Mesa's DRI drivers
 * do: each plane's rows hold its drm_format_info samples (subsampled planes
 * rounded up, a packed YUYV/UYVY row ending with a whole pixel pair),
 * rounded to 4 bytes like a dumb buffer's, one plane after another. Fails
 * (0) when the layout does not fit 32-bit strides and offsets. */
static int plane_layout(const struct wpk_drm_format_info *layout, uint32_t width, uint32_t height,
                        uint32_t strides[3], uint32_t offsets[3], uint64_t *size) {
    uint64_t total = 0;
    for (unsigned plane = 0; plane < layout->num_planes; plane++) {
        uint64_t stride = (wpk_drm_row_bytes(layout, width, plane) + 3) & ~(uint64_t)3;
        if (stride > UINT32_MAX || total > UINT32_MAX) return 0;
        strides[plane] = (uint32_t)stride;
        offsets[plane] = (uint32_t)total;
        total += stride * wpk_drm_plane_height(layout, height, plane);
    }
    if (total > UINT32_MAX) return 0;
    *size = total;
    return 1;
}

static struct gbm_bo *bo_create(struct gbm_device *gbm,
                                uint32_t width, uint32_t height,
                                uint32_t format, uint32_t flags,
                                int gpu_tier, int owned_device) {
    format = canonical_format(format);
    const struct wpk_drm_format_info *layout = format_layout(format);
    uint32_t strides[3] = {0}, offsets[3] = {0};
    uint64_t yuv_size = 0;
    if (!gbm || !layout || !width || !height || (flags & ~WPK_GBM_SUPPORTED_USAGE)
        || !usage_serves_format(format_info(format), flags)
        || (layout->is_yuv && !plane_layout(layout, width, height, strides, offsets, &yuv_size))) {
        errno = EINVAL;
        return NULL;
    }
    uint32_t bpp = layout->cpp[0] * 8;
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
    bo->bpp      = layout_bpp(layout);
    bo->cpp      = layout->cpp[0];
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
        if (_wpk_drm_owned_ioctl(gbm->owner,WPK_DRM_IOCTL_CREATE_GPU_BO,&greq,sizeof greq,
                NULL,WPK_DRM_OWNED_CAPTURE_BO,&bo->planes[0].owner)==0) {
            bo->handle = greq.format;   /* out: per-fd handle */
            bo->stride = greq.usage;    /* out: stride (bytes) */
            bo->size   = (uint64_t) greq.usage * height;
            bo->is_gpu = 1;
            bo->plane_count = 1;
            bo->planes[0].handle = bo->handle;
            bo->planes[0].stride = bo->stride;
            register_bo(bo);
            return bo;
        }
        _wpk_drm_owned_retire(&bo->planes[0].owner);
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
    if (layout->is_yuv) {
        /* One byte-wide dumb object of rows as long as plane 0's, enough
         * of them to hold every plane. */
        req.width = strides[0];
        req.height = (uint32_t)((yuv_size + strides[0] - 1) / strides[0]);
        req.bpp = 8;
    }
    if (_wpk_drm_owned_ioctl(gbm->owner,DRM_IOCTL_MODE_CREATE_DUMB,&req,sizeof req,
            NULL,WPK_DRM_OWNED_CAPTURE_BO,&bo->planes[0].owner)<0) {
        _wpk_drm_owned_retire(&bo->planes[0].owner);
        int save = errno;
        free(bo);
        release_device(gbm);
        errno = save;
        return NULL;
    }
    bo->handle = req.handle;
    bo->stride = req.pitch;
    bo->size   = req.size;
    bo->plane_count = layout->num_planes;
    for (unsigned plane = 0; plane < layout->num_planes; plane++) {
        bo->planes[plane].owner=bo->planes[0].owner;
        bo->planes[plane].handle = req.handle;
        bo->planes[plane].stride = layout->is_yuv ? strides[plane] : req.pitch;
        bo->planes[plane].offset = offsets[plane];
    }
    if (layout->is_yuv) {
        bo->stride = strides[0];
        bo->size = yuv_size;
    }
    register_bo(bo);
    return bo;
}

struct gbm_bo *gbm_bo_create(struct gbm_device *gbm,
                             uint32_t width, uint32_t height,
                             uint32_t format, uint32_t flags) {
    return bo_create(gbm, width, height, format, flags,
                     usage_wants_gpu_tier(flags), 0);
}

/* Every bo is linear, so a modifier list is satisfiable
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

/* A single allocation may supply several planes. Imports each own their
 * own kernel capability, even when PRIME returns the same public GEM name. */
static void defer_plane_owners_published(struct gbm_bo *bo) {
    struct wpk_drm_owner *released[GBM_MAX_PLANES]={0};unsigned count=0;
    for(unsigned plane=0;plane<GBM_MAX_PLANES;plane++){
        struct wpk_drm_owner *owner=bo->planes[plane].owner;int repeated=0;
        for(unsigned i=0;i<count;i++)repeated|=released[i]==owner;
        if(owner&&!repeated){released[count++]=owner;_wpk_drm_owned_defer_locked(&bo->planes[plane].owner);}
        bo->planes[plane].owner=NULL;
    }
}
static void release_plane_owners(struct gbm_bo *bo) {
    _wpk_drm_owned_publication_begin();
    defer_plane_owners_published(bo);
    _wpk_drm_owned_publication_end();
}
static int bo_ioctl(struct gbm_device *device,struct wpk_drm_owner *bo,
                    uint32_t request,void *body,uint32_t length) {
    struct wpk_drm_bo_binding binding={0,bo};
    return _wpk_drm_owned_ioctl_bo(device->owner,request,body,length,NULL,0,NULL,&binding,1);
}

/* Import the linear planes of a dma-buf image, one fd, stride and offset
 * per plane of the format (drm_format_info.h); the fds may name one object
 * or several. Like a Mesa driver, the caller's geometry is checked against
 * the real objects: each stride must hold a row of its plane and offset +
 * stride * rows must fit in that plane's dma-buf, whose size PRIME
 * lseek(SEEK_END) reports (Linux dma_buf_llseek). The tier comes from the
 * kernel too: MAP_DUMB fails with EINVAL only for an unmappable GPU-tier BO,
 * which is then marked exactly as a native GPU allocation is; its storage
 * must be the plane's format. */
static struct gbm_bo *import_planes(struct gbm_device *gbm, unsigned count, const int *fds,
                                    uint32_t width, uint32_t height, uint32_t format,
                                    const uint32_t *strides, const uint32_t *offsets, uint32_t usage) {
    format = canonical_format(format);
    const struct wpk_drm_format_info *layout = format_layout(format);
    if (!gbm || !width || !height || !layout || count != layout->num_planes
        || (usage & ~WPK_GBM_SUPPORTED_USAGE) || !usage_serves_format(format_info(format), usage)) {
        errno = EINVAL;
        return NULL;
    }
    for (unsigned plane = 0; plane < count; plane++) {
        if (fds[plane] < 0 || wpk_drm_row_bytes(layout, width, plane) > strides[plane]) {
            errno = EINVAL;
            return NULL;
        }
    }
    if (!retain_device(gbm)) return NULL;

    /* Allocate before import: a failed userspace allocation must not close
     * a cached handle still owned by another public BO. */
    struct gbm_bo *bo = calloc(1, sizeof *bo);
    if (!bo) { release_device(gbm); errno = ENOMEM; return NULL; }
    uint32_t handles[GBM_MAX_PLANES] = {0};
    int error = 0, any_gpu = 0;
    int cancel_state;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&cancel_state);
    _wpk_drm_mutex_lock(&handle_mutex);
    for (unsigned plane = 0; plane < count && !error; plane++) {
        struct drm_prime_handle req = {.fd = fds[plane]};
        struct wpk_drm_owner *prime=NULL;
        if(_wpk_drm_owned_acquire(fds[plane],0,&prime)!=0){
            error=errno;_wpk_drm_owned_retire(&prime);break;
        }
        int imported=_wpk_drm_owned_ioctl(gbm->owner,DRM_IOCTL_PRIME_FD_TO_HANDLE,&req,sizeof req,
            prime,WPK_DRM_OWNED_CAPTURE_BO,&bo->planes[plane].owner);
        int import_error=errno;_wpk_drm_owned_retire(&prime);
        if(imported<0){error=import_error;break;}
        handles[plane] = req.handle;
        struct wpk_drm_bo_info info;
        if(_wpk_drm_owned_bo_info(bo->planes[plane].owner,&info)!=0){error=errno;break;}
        uint64_t real_size=info.size;
        uint64_t rows = wpk_drm_plane_height(layout, height, plane);
        if ((uint64_t)strides[plane] * rows + offsets[plane] > real_size) {
            error = EINVAL;
            break;
        }
        int gpu = 0;
        struct drm_mode_map_dumb probe = {.handle = req.handle};
        if (bo_ioctl(gbm,bo->planes[plane].owner,DRM_IOCTL_MODE_MAP_DUMB,&probe,sizeof probe) == 0) gpu = 0;
        else if (errno == EINVAL) gpu = 1;
        else { error = errno; break; }
        /* A GPU-tier BO is a texture of its own format: the claimed format
         * (for a YUV plane, the plane's format: NV12's luma R8, its chroma
         * GR88) must name that storage (Mesa's import likewise rejects a
         * format the driver cannot sample the buffer as). */
        if (gpu) {
            /* A texture has no byte addressing: a plane starts at its
             * origin or nowhere. */
            if (layout->is_yuv && offsets[plane] != 0) { error = EINVAL; break; }
            struct wpk_drm_check_bo_format check = {.handle = req.handle, .format = layout->plane_formats[plane]};
            if (bo_ioctl(gbm,bo->planes[plane].owner,WPK_DRM_IOCTL_CHECK_BO_FORMAT,&check,sizeof check) != 0) { error = errno; break; }
        }
        if (plane == 0) bo->is_gpu = gpu;
        any_gpu |= gpu;
    }
    /* gbm_bo_write needs CPU storage a GPU-tier plane does not have. */
    if (!error && any_gpu && (usage & GBM_BO_USE_WRITE)) error = EINVAL;
    if (error) {
        release_plane_owners(bo);
        _wpk_drm_mutex_unlock(&handle_mutex);
        free(bo);
        release_device(gbm);
        _wpk_drm_owned_drain();
        pthread_setcancelstate(cancel_state,NULL);
        errno = error;
        return NULL;
    }
    bo->dev      = gbm;
    bo->handle   = handles[0];
    bo->width    = width;
    bo->height   = height;
    bo->stride   = strides[0];
    bo->size     = (uint64_t) strides[0] * height;
    bo->offset   = offsets[0];
    bo->format   = format;
    bo->bpp      = layout_bpp(layout);
    bo->cpp      = layout->cpp[0];
    bo->modifier = DRM_FORMAT_MOD_LINEAR;
    bo->plane_count = count;
    for (unsigned plane = 0; plane < count; plane++) {
        bo->planes[plane].handle = handles[plane];
        bo->planes[plane].stride = strides[plane];
        bo->planes[plane].offset = offsets[plane];
    }
    bo->handle_next = live_bos;
    live_bos = bo;
    _wpk_drm_mutex_unlock(&handle_mutex);
    pthread_setcancelstate(cancel_state,NULL);
    return bo;
}

static struct gbm_bo *import_plane(struct gbm_device *gbm, int fd,
                                   uint32_t width, uint32_t height, uint32_t format,
                                   uint32_t stride, uint32_t offset, uint32_t usage) {
    return import_planes(gbm, 1, &fd, width, height, format, &stride, &offset, usage);
}

struct gbm_bo *gbm_bo_import(struct gbm_device *gbm, uint32_t type,
                             void *buffer, uint32_t flags) {
    if (!gbm || !buffer) {
        errno = EINVAL;
        return NULL;
    }
    if (type == GBM_BO_IMPORT_FD) {
        struct gbm_import_fd_data *d = (struct gbm_import_fd_data *) buffer;
        return import_plane(gbm, d->fd, d->width, d->height, d->format,
                            d->stride, 0, flags);
    }
    if (type == GBM_BO_IMPORT_FD_MODIFIER) {
        struct gbm_import_fd_modifier_data *d =
            (struct gbm_import_fd_modifier_data *) buffer;
        /* One fd, stride and offset per plane of the format, as Mesa's DRI
         * import requires. Every BO is linear, so only an explicit LINEAR
         * or an implicit (INVALID) layout describes a real buffer; tiled
         * imports are refused rather than reinterpreted as linear. */
        if (d->num_fds == 0 || d->num_fds > GBM_MAX_PLANES ||
            (d->modifier != DRM_FORMAT_MOD_LINEAR && d->modifier != DRM_FORMAT_MOD_INVALID)) {
            errno = EINVAL;
            return NULL;
        }
        uint32_t strides[GBM_MAX_PLANES], offsets[GBM_MAX_PLANES];
        for (unsigned plane = 0; plane < d->num_fds; plane++) {
            if (d->strides[plane] <= 0 || d->offsets[plane] < 0) {
                errno = EINVAL;
                return NULL;
            }
            strides[plane] = (uint32_t)d->strides[plane];
            offsets[plane] = (uint32_t)d->offsets[plane];
        }
        return import_planes(gbm, d->num_fds, d->fds, d->width, d->height, d->format,
                             strides, offsets, flags);
    }
    if (type == GBM_BO_IMPORT_EGL_IMAGE) {
        /* Mesa gbm_dri_bo_import: the EGLImage must belong to the EGL
         * display initialized on this device, and the bo shares its storage
         * with the image's format, extent and pitch (here through a PRIME
         * descriptor of the image's bo). import_plane validates the usage
         * against that storage as for any dma-buf. */
        struct wpk_gbm_image image;
        if (!retain_device(gbm)) return NULL;
        errno = EINVAL;
        int exported = _wpk_egl_image_export_gbm &&
            _wpk_egl_image_export_gbm(buffer, gbm, gbm->identity, &image) == 0;
        struct gbm_bo *bo = exported && image.num_planes <= GBM_MAX_PLANES
            ? import_planes(gbm, image.num_planes, image.fds, image.width, image.height,
                            image.format, image.strides, image.offsets, flags)
            : NULL;
        int error = errno;
        if (exported)
            for (unsigned plane = 0; plane < image.num_planes && plane < GBM_MAX_PLANES; plane++)
                close(image.fds[plane]);
        release_device(gbm);
        errno = error;
        return bo;
    }
    errno = EINVAL;
    return NULL;
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
    if (bo_ioctl(bo->dev,bo->planes[0].owner,DRM_IOCTL_PRIME_HANDLE_TO_FD,&req,sizeof req) < 0) {
        return -1;
    }
    return req.fd;
}

int gbm_bo_get_fd_for_plane(struct gbm_bo *bo, int plane) {
    if (!bo || plane < 0 || (unsigned)plane >= bo->plane_count) {
        errno = EINVAL;
        return -1;
    }
    struct drm_prime_handle req = {.handle = bo->planes[plane].handle, .flags = O_CLOEXEC | O_RDWR};
    if (bo_ioctl(bo->dev,bo->planes[plane].owner,DRM_IOCTL_PRIME_HANDLE_TO_FD,&req,sizeof req) < 0) return -1;
    return req.fd;
}

/* Caller holds mapping_mutex. Map the canonical BO once so overlapping
 * CPU views alias the same bytes until the final view is released. */
static int map_bo_locked(struct gbm_bo *bo) {
    if (bo->map_addr) return 0;
    /* MAP_DUMB maps from the object's start; an imported plane begins at
     * its offset, so the mapping covers the offset and the plane view. */
    uint64_t length = bo->size + bo->offset;
    if (length > SIZE_MAX) { errno = EOVERFLOW; return -1; }
    struct drm_mode_map_dumb req = {.handle = bo->handle};
    if (bo_ioctl(bo->dev,bo->planes[0].owner,DRM_IOCTL_MODE_MAP_DUMB,&req,sizeof req) < 0) return -1;
    if(_wpk_drm_owned_map_exact(&bo->mapping,bo->dev->owner,bo->planes[0].owner,0,length,
            req.offset,PROT_READ|PROT_WRITE,MAP_SHARED)!=0)return -1;
    void *addr=(void *)(uintptr_t)bo->mapping.address;
    bo->map_addr = addr;
    bo->map_len = (size_t)length;
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
    /* The first plane, in its own samples (a YUV buffer's luma or packed
     * pairs). */
    uint64_t x_bytes = (uint64_t)x * bo->cpp;
    uint64_t row_bytes = (uint64_t)width * bo->cpp;
    if (x_bytes + row_bytes > bo->stride ||
        ((uint64_t)y + height - 1) * bo->stride + x_bytes + row_bytes > bo->size) {
        errno = EINVAL;
        return NULL;
    }
    struct gbm_mapping *mapping = calloc(1, sizeof *mapping);
    if (!mapping) { errno = ENOMEM; return NULL; }
    _wpk_drm_mutex_lock(&mapping_mutex);
    if (!next_mapping_token || map_bo_locked(bo) < 0) {
        if (!next_mapping_token) errno = ENOMEM;
        _wpk_drm_mutex_unlock(&mapping_mutex);
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
    void *address = (char *)bo->map_addr +
        (size_t)(bo->offset + (uint64_t)y * bo->stride + x_bytes);
    *stride = bo->stride;
    *map_data = (void *)mapping->token;
    _wpk_drm_mutex_unlock(&mapping_mutex);
    return address;
}

static int unmap_bo_locked(struct gbm_bo *bo, void *map_data) {
    struct gbm_mapping **link = &bo->mappings;
    while (*link && (*link)->token != (uintptr_t)map_data) link = &(*link)->next;
    if (!*link) { errno = EINVAL; return -1; }
    struct gbm_mapping *mapping = *link;
    if (link == &bo->mappings && !mapping->next) {
        // Keep the lease and address if the kernel did not accept release.
        if (_wpk_drm_owned_unmap_exact(&bo->mapping) < 0) return -1;
        bo->map_addr = NULL;
        bo->map_len = 0;
    }
    *link = mapping->next;
    free(mapping);
    return 0;
}

void gbm_bo_unmap(struct gbm_bo *bo, void *map_data) {
    if (!bo) { errno = EINVAL; return; }
    _wpk_drm_mutex_lock(&mapping_mutex);
    unmap_bo_locked(bo, map_data);
    _wpk_drm_mutex_unlock(&mapping_mutex);
}

/* A published slot keeps BO, FILE, device and mapping custody together.
 * A callback may fork/reenter or exit its thread: a live scope owns its C
 * stack, whereas a dead scope permits another actor to finish without replay.
 * Process-epoch comparisons alone would free a surviving fork caller's stack. */
static void finish_claimed_bo(struct gbm_bo *bo,struct gbm_bo **receiver) {
    void (*callback)(struct gbm_bo *, void *) = NULL;
    void *data = NULL;
    _wpk_drm_owned_publication_begin();
    bo->surface = NULL;
    if(bo->user_data_destroy&&!bo->callback_started){
        if(!_wpk_drm_actor_try_claim_locked(&bo->callback_claim))abort();
        bo->callback_started=1;callback=bo->user_data_destroy;data=bo->user_data;
    }else if(bo->callback_started&&_wpk_drm_actor_claim_live_locked(&bo->callback_claim))abort();
    _wpk_drm_owned_publication_end();
    if(callback)callback(bo,data);
    _wpk_drm_owned_publication_begin();
    bo->user_data=NULL;bo->user_data_destroy=NULL;
    _wpk_drm_actor_release_locked(&bo->callback_claim);
    _wpk_drm_owned_publication_end();
    _wpk_drm_mutex_lock(&mapping_mutex);
    /* Exact retirement must finish while the capsule and both source edges
     * are still globally rooted. Clearing the BO slot first would orphan an
     * inherited map; retaining only its address would endanger replacements. */
    if(_wpk_drm_owned_unmap_exact(&bo->mapping)<0){
        int error=errno;
        _wpk_drm_mutex_unlock(&mapping_mutex);
        _wpk_drm_owned_publication_begin();
        _wpk_drm_actor_release_locked(&bo->destruction_claim);
        _wpk_drm_owned_publication_end();
        fprintf(stderr,"Kandelo GBM: exact mapping retirement failed (errno=%d); BO custody retained\n",error);
        errno=error;return;
    }
    _wpk_drm_mutex_lock(&handle_mutex);
    _wpk_drm_mutex_lock(&device_mutex);
    struct gbm_device *device=bo->dev;
    _wpk_drm_owned_publication_begin();
    defer_plane_owners_published(bo);
    struct gbm_bo **link=&live_bos;
    while(*link&&*link!=bo)link=&(*link)->handle_next;
    if(*link)*link=bo->handle_next;
    int device_retired=release_device_published(device);
    if(receiver){if(*receiver!=bo)abort();*receiver=NULL;}
    if(bo->retiring){
        /* User callbacks can prepend or synchronously destroy another BO.
         * A saved head/next slot would now name somebody else's actor. Remove
         * this exact node only, with the same guard as its native custody. */
        struct gbm_bo **retired=&retired_bos;
        while(*retired&&*retired!=bo)retired=&(*retired)->retirement_next;
        if(!*retired)abort();*retired=bo->retirement_next;
    }
    _wpk_drm_actor_release_locked(&bo->destruction_claim);
    _wpk_drm_owned_publication_end();
    _wpk_drm_mutex_unlock(&device_mutex);
    _wpk_drm_mutex_unlock(&handle_mutex);
    while(bo->mappings){struct gbm_mapping *mapping=bo->mappings;bo->mappings=mapping->next;free(mapping);}
    _wpk_drm_mutex_unlock(&mapping_mutex);
    if(device_retired)free(device);
    free(bo);_wpk_drm_owned_drain();
}
static void destroy_bo_slot(struct gbm_bo **receiver) {
    if(!_wpk_drm_actor_prepare()){
        fprintf(stderr,"Kandelo GBM: cleanup scope unavailable; BO slot retained\n");return;
    }
    _wpk_drm_owned_publication_begin();
    struct gbm_bo *bo=*receiver;
    int claimed=bo&&_wpk_drm_actor_try_claim_locked(&bo->destruction_claim);
    _wpk_drm_owned_publication_end();
    if(claimed)finish_claimed_bo(bo,receiver);
}
static void drain_retired_bos(void) {
    if(!atomic_load_explicit(&bo_retire_pending,memory_order_acquire))return;
    if(!_wpk_drm_actor_prepare())return;
    uint64_t visit=_wpk_owned_resource_nonce();
    if(!visit){fprintf(stderr,"Kandelo GBM: retirement visit exhausted; queue retained\n");return;}
    _wpk_drm_owned_publication_begin();
    int claimed=_wpk_drm_actor_try_claim_locked(&bo_drain_claim);
    _wpk_drm_owned_publication_end();if(!claimed)return;
    for(;;){
        _wpk_drm_owned_publication_begin();
        struct gbm_bo *bo=retired_bos;
        while(bo&&bo->drain_visit_nonce==visit)bo=bo->retirement_next;
        int entered=0;
        if(bo){
            bo->drain_visit_nonce=visit;
            entered=_wpk_drm_actor_try_claim_locked(&bo->destruction_claim);
        }
        _wpk_drm_owned_publication_end();
        if(!bo)break;
        /* Selection and claim publication are inseparable. Native callbacks
         * may remove other nodes, so retain no list cursor across entry. A
         * failed actor is visited once, with no retired-ID/tombstone list. */
        if(entered)finish_claimed_bo(bo,NULL);
    }
    _wpk_drm_owned_publication_begin();
    if(!retired_bos)atomic_store_explicit(&bo_retire_pending,0,memory_order_release);
    _wpk_drm_actor_release_locked(&bo_drain_claim);
    _wpk_drm_owned_publication_end();
}
void gbm_bo_destroy(struct gbm_bo *bo) {
    if(!bo)return;
    int cancel_state;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&cancel_state);
    int prepared=_wpk_drm_actor_prepare();
    _wpk_drm_owned_publication_begin();
    if(!bo->retiring){bo->retiring=1;bo->retirement_next=retired_bos;retired_bos=bo;atomic_store_explicit(&bo_retire_pending,1,memory_order_release);}
    /* The queued node and this caller's stack claim publish together. A
     * drainer could otherwise free it while scope preparation still runs.
     * Failed preparation publishes custody but never dereferences it again. */
    int claimed=prepared&&_wpk_drm_actor_try_claim_locked(&bo->destruction_claim);
    _wpk_drm_owned_publication_end();
    if(claimed)finish_claimed_bo(bo,NULL);
    if(prepared)drain_retired_bos();
    pthread_setcancelstate(cancel_state,NULL);
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
    _wpk_drm_mutex_lock(&mapping_mutex);
    int result = unmap_bo_locked(bo, token);
    if (result < 0) {
        for (struct gbm_mapping *mapping = bo->mappings; mapping; mapping = mapping->next) {
            if (mapping->token == (uintptr_t)token) {
                mapping->internal_release_pending = 1;
                break;
            }
        }
    }
    _wpk_drm_mutex_unlock(&mapping_mutex);
    return result;
}

/* Mesa only stores the pair; the destructor runs solely from gbm_bo_destroy.
 * Clients routinely free their data themselves and then clear the slot with
 * (NULL, NULL), so invoking the previous destructor here would double-free. */
void gbm_bo_set_user_data(struct gbm_bo *bo, void *data,
                          void (*destroy_user_data)(struct gbm_bo *, void *)) {
    if (!bo) return;
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

/* Per-plane accessors report each plane of the format (one for RGB, two or
 * three for planar YUV). SDL2's KMSDRM backend walks planes to build its
 * drmModeAddFB2 call. An absent plane follows Mesa: errno EINVAL with
 * handle .s32 == -1 (handle 0 would name "no buffer"), stride 0 and offset
 * 0, so a caller cannot mistake it for a real plane. */

int gbm_bo_get_plane_count(struct gbm_bo *bo) {
    return (int)bo->plane_count;
}

static int plane_exists(struct gbm_bo *bo, int plane) {
    if (plane >= 0 && (unsigned)plane < bo->plane_count) return 1;
    errno = EINVAL;
    return 0;
}

union gbm_bo_handle gbm_bo_get_handle_for_plane(struct gbm_bo *bo, int plane) {
    union gbm_bo_handle h;
    if (!plane_exists(bo, plane)) {
        h.s64 = 0;
        h.s32 = -1;
        return h;
    }
    h.u64 = 0;
    h.u32 = bo->planes[plane].handle;
    return h;
}

uint32_t gbm_bo_get_stride_for_plane(struct gbm_bo *bo, int plane) {
    return plane_exists(bo, plane) ? bo->planes[plane].stride : 0;
}

uint32_t gbm_bo_get_offset(struct gbm_bo *bo, int plane) {
    return plane_exists(bo, plane) ? bo->planes[plane].offset : 0;
}

/* Report what an allocation with these usages can actually do. Like Mesa's
 * DRI backend, a cursor is never also a render target, and unknown or
 * unsupported usages are unsupported. The kernel cursor plane takes only
 * ARGB8888 (kms::CURSOR_PLANE_FORMATS), the primary plane the k_formats
 * marked scanout; every RGB format is a render target and no YUV format
 * is. */
int gbm_device_is_format_supported(struct gbm_device *gbm,
                                   uint32_t format, uint32_t flags) {
    (void) gbm;
    format = canonical_format(format);
    const struct wpk_gbm_format *info = format_info(format);
    if (!info || (flags & ~WPK_GBM_SUPPORTED_USAGE)) return 0;
    if (flags & GBM_BO_USE_CURSOR)
        return !(flags & GBM_BO_USE_RENDERING) && format == GBM_FORMAT_ARGB8888;
    return usage_serves_format(info, flags);
}

/* The render back is private GPU storage. Public CPU-facing usage flags
 * apply to exported fronts, so they must not silently become unmappable. */
static struct gbm_bo *surface_alloc_bo(struct gbm_surface *s, int gpu) {
    uint32_t flags = s->flags;
    if (gpu == 2)
        flags &= ~(GBM_BO_USE_WRITE | GBM_BO_USE_LINEAR | GBM_BO_USE_CURSOR);
    struct gbm_bo *bo = bo_create(s->dev, s->width, s->height,
                                s->format, flags, gpu, 1);
    if (bo) bo->surface = s;
    return bo;
}

struct gbm_surface *gbm_surface_create(struct gbm_device *gbm,
                                       uint32_t width, uint32_t height,
                                       uint32_t format, uint32_t flags) {
    format = canonical_format(format);
    if (!gbm || !width || !height || !format_surface(format) ||
        (flags & ~WPK_GBM_SUPPORTED_USAGE)) {
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
    _wpk_drm_mutex_lock(&surface_mutex);
    s->live_next = live_surfaces;
    live_surfaces = s;
    _wpk_drm_mutex_unlock(&surface_mutex);
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
/* surface_mutex is held; caller prepared its scope and disabled cancellation
 * before any metadata effect. Fold withdrawal/release into the same guarded
 * publication as queue custody, rather than leaving a dead live-list node. */
static struct gbm_surface *retire_surface_locked(struct gbm_surface *s,int prepared,
    int withdraw_public,int withdraw_window,struct gbm_bo *release_bo,struct wpk_gbm_front_hold *consume) {
    int retire=(!s->public_live||withdraw_public)&&(!s->window_owned||withdraw_window);
    for(unsigned i=0;i<WPK_GBM_SURFACE_BO_COUNT;i++)
        if(s->in_use[i]&&s->bos[i]!=release_bo)retire=0;
    if(retire)_wpk_drm_mutex_lock(&device_mutex);
    _wpk_drm_owned_publication_begin();
    if(withdraw_public)s->public_live=0;
    if(withdraw_window){s->window_owned=0;s->back=s->front=s->pending=-1;}
    if(release_bo)for(unsigned i=0;i<WPK_GBM_SURFACE_BO_COUNT;i++)
        if(s->bos[i]==release_bo){s->in_use[i]=0;break;}
    if(consume){consume->surface=NULL;consume->bo=NULL;}
    if(retire){
        struct gbm_surface **link=&live_surfaces;
        while(*link&&*link!=s)link=&(*link)->live_next;
        if(*link)*link=s->live_next;
        s->device_retired=release_device_published(s->dev);
        s->retirement_next=retired_surfaces;retired_surfaces=s;
        atomic_store_explicit(&surface_retire_pending,1,memory_order_release);
        if(prepared&&!_wpk_drm_actor_try_claim_locked(&s->retirement_claim))abort();
    }
    _wpk_drm_owned_publication_end();
    if(retire)_wpk_drm_mutex_unlock(&device_mutex);
    return retire&&prepared?s:NULL;
}

static void finish_claimed_surface(struct gbm_surface *s) {
    for(unsigned i=0;i<WPK_GBM_SURFACE_BO_COUNT;i++)destroy_bo_slot(&s->bos[i]);
    _wpk_drm_owned_publication_begin();
    for(unsigned i=0;i<WPK_GBM_SURFACE_BO_COUNT;i++)if(s->bos[i]){
        _wpk_drm_actor_release_locked(&s->retirement_claim);
        _wpk_drm_owned_publication_end();return;
    }
    struct gbm_surface **link=&retired_surfaces;
    while(*link&&*link!=s)link=&(*link)->retirement_next;
    if(!*link)abort();*link=s->retirement_next;
    if(!retired_surfaces)atomic_store_explicit(&surface_retire_pending,0,memory_order_release);
    if(s->device_retired)free(s->dev);
    _wpk_drm_actor_release_locked(&s->retirement_claim);
    free(s);_wpk_drm_owned_publication_end();_wpk_drm_owned_drain();
}
/* Eligible callers publish their stack claim before dropping surface_mutex.
 * A preparation failure returns NULL after queue publication: another actor
 * can already own the node, so the original caller must not dereference it. */
static void free_surface(struct gbm_surface *s) {
    if(s)finish_claimed_surface(s);
}

static void drain_retired_surfaces(void) {
    if(!atomic_load_explicit(&surface_retire_pending,memory_order_acquire))return;
    int cancel_state;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&cancel_state);
    if(!_wpk_drm_actor_prepare()){pthread_setcancelstate(cancel_state,NULL);return;}
    uint64_t visit=_wpk_owned_resource_nonce();
    if(!visit){fprintf(stderr,"Kandelo GBM: surface retirement visit exhausted; ring retained\n");pthread_setcancelstate(cancel_state,NULL);return;}
    _wpk_drm_owned_publication_begin();
    int entered=_wpk_drm_actor_try_claim_locked(&surface_drain_claim);
    _wpk_drm_owned_publication_end();
    if(entered){
        for(;;){
            _wpk_drm_owned_publication_begin();
            struct gbm_surface *s=retired_surfaces;
            while(s&&s->drain_visit_nonce==visit)s=s->retirement_next;
            int claimed=0;
            if(s){s->drain_visit_nonce=visit;claimed=_wpk_drm_actor_try_claim_locked(&s->retirement_claim);}
            _wpk_drm_owned_publication_end();
            if(!s)break;
            if(claimed)finish_claimed_surface(s);
        }
        _wpk_drm_owned_publication_begin();
        if(!retired_surfaces)atomic_store_explicit(&surface_retire_pending,0,memory_order_release);
        _wpk_drm_actor_release_locked(&surface_drain_claim);
        _wpk_drm_owned_publication_end();
    }
    pthread_setcancelstate(cancel_state,NULL);
}

static void surface_frame(struct gbm_surface *s, int index, struct wpk_gbm_frame *frame) {
    struct gbm_bo *bo = s->bos[index];
    *frame = (struct wpk_gbm_frame){s->dev->fd, bo->handle, s->width, s->height,
        bo->format, bo->stride,s->dev->owner,bo->planes[0].owner};
}
int _wpk_gbm_window_acquire(const void *window, void **lease, struct wpk_gbm_frame *frame) {
    struct gbm_bo *replaced[WPK_GBM_SURFACE_BO_COUNT] = {0};
    int accepted = 0;
    _wpk_drm_mutex_lock(&surface_mutex);
    struct gbm_surface *s = find_surface_locked(window);
    if (!s || !s->public_live) errno = EINVAL;
    else if (s->window_owned) errno = EBUSY;
    else if (!(s->flags & GBM_BO_USE_RENDERING))
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
    _wpk_drm_mutex_unlock(&surface_mutex);
    for (unsigned i = 0; i < WPK_GBM_SURFACE_BO_COUNT; ++i)
        if (replaced[i]) { replaced[i]->surface = NULL; gbm_bo_destroy(replaced[i]); }
    return accepted;
}
int _wpk_gbm_window_prepare(void *lease, struct wpk_gbm_frame *frame) {
    int accepted = 0;
    struct gbm_bo *replaced = NULL;
    _wpk_drm_mutex_lock(&surface_mutex);
    struct gbm_surface *s = find_surface_locked(lease);
    if (!s || !s->window_owned || s->pending >= 0) errno = EINVAL;
    else {
        errno = EBUSY;
        int gpu = !(s->flags & (GBM_BO_USE_WRITE | GBM_BO_USE_LINEAR | GBM_BO_USE_CURSOR));
        for (int i = 0; i < WPK_GBM_SURFACE_BO_COUNT; ++i) {
            if (i == s->back || i == s->front || s->in_use[i]) continue;
            struct gbm_bo *bo = s->bos[i];
            if (!bo || bo->is_gpu != gpu) {
                bo = surface_alloc_bo(s, gpu ? 2 : 0);
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
    _wpk_drm_mutex_unlock(&surface_mutex);
    if (replaced) { replaced->surface = NULL; gbm_bo_destroy(replaced); }
    return accepted;
}
void _wpk_gbm_window_finish(void *lease, int accepted) {
    _wpk_drm_mutex_lock(&surface_mutex);
    struct gbm_surface *s = find_surface_locked(lease);
    if (s && s->window_owned && s->pending >= 0) {
        if (accepted) s->front = s->pending;
        s->pending = -1;
    }
    _wpk_drm_mutex_unlock(&surface_mutex);
}
/* Keep the removed ring in the caller's published continuation until every
 * BO slot has transferred exact custody. Clearing only the live lease before
 * the old free_surface loop would strand the rest if another thread forks. */
static void retire_surface_pending(struct wpk_gbm_window_retirement *state, int destroy_public) {
    if (!state) abort();
    int cancel_state; pthread_setcancelstate(PTHREAD_CANCEL_DISABLE, &cancel_state);
    _wpk_drm_mutex_lock(&surface_mutex);
    struct gbm_surface *s = state->live ? find_surface_locked(state->live) : NULL;
    if (state->live && state->retired) abort();
    if (state->live) {
        if (s) _wpk_drm_mutex_lock(&device_mutex);
        _wpk_drm_owned_publication_begin();
        if (s) {
            if (destroy_public) s->public_live = 0;
            else { s->window_owned = 0; s->back = s->front = s->pending = -1; }
            int retire = !s->public_live && !s->window_owned;
            for (unsigned i = 0; i < WPK_GBM_SURFACE_BO_COUNT; i++)
                if (s->in_use[i]) retire = 0;
            if (retire) {
                struct gbm_surface **link = &live_surfaces;
                while (*link && *link != s) link = &(*link)->live_next;
                if (*link) *link = s->live_next;
                s->device_retired = release_device_published(s->dev);
                state->retired = s;
            }
        }
        state->live = NULL;
        _wpk_drm_owned_publication_end();
        if (s) _wpk_drm_mutex_unlock(&device_mutex);
    }
    _wpk_drm_mutex_unlock(&surface_mutex);
    s = state->retired;
    if (s) {
        for (unsigned i = 0; i < WPK_GBM_SURFACE_BO_COUNT; i++) destroy_bo_slot(&s->bos[i]);
        for(unsigned i=0;i<WPK_GBM_SURFACE_BO_COUNT;i++)if(s->bos[i]){
            pthread_setcancelstate(cancel_state,NULL);return;
        }
        _wpk_drm_owned_publication_begin();
        if (s->device_retired) free(s->dev);
        state->retired = NULL; free(s);
        _wpk_drm_owned_publication_end();
        _wpk_drm_owned_drain();
    }
    pthread_setcancelstate(cancel_state, NULL);
}
void _wpk_gbm_window_release_pending(struct wpk_gbm_window_retirement *state) {
    retire_surface_pending(state, 0);
}
void _wpk_gbm_surface_destroy_pending(struct wpk_gbm_window_retirement *state) {
    retire_surface_pending(state, 1);
}
/* Slot consumption and the public device edge are inseparable. Otherwise a
 * fork after withdrawal could retain a pointer to an already consumed device,
 * or lose the only actor that should finish its last FILE reference. */
void _wpk_gbm_device_destroy_pending(struct gbm_device **receiver) {
    if (!receiver) abort();
    int cancel_state; pthread_setcancelstate(PTHREAD_CANCEL_DISABLE, &cancel_state);
    _wpk_drm_mutex_lock(&device_mutex);
    struct gbm_device *device = *receiver;
    struct gbm_device **link = &live_devices;
    while (*link && *link != device) link = &(*link)->live_next;
    _wpk_drm_owned_publication_begin();
    if (device && *link) {
        *link = device->live_next;
        if (release_device_published(device)) free(device);
    }
    *receiver = NULL;
    _wpk_drm_owned_publication_end();
    _wpk_drm_mutex_unlock(&device_mutex);
    _wpk_drm_owned_drain();
    pthread_setcancelstate(cancel_state, NULL);
}
void _wpk_gbm_window_release(void *lease) {
    int cancel_state;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&cancel_state);
    int prepared=_wpk_drm_actor_prepare();
    _wpk_drm_mutex_lock(&surface_mutex);
    struct gbm_surface *s=find_surface_locked(lease),*retired=NULL;
    if(s&&s->window_owned)retired=retire_surface_locked(s,prepared,0,1,NULL,NULL);
    _wpk_drm_mutex_unlock(&surface_mutex);
    free_surface(retired);pthread_setcancelstate(cancel_state,NULL);
}

struct gbm_bo *gbm_surface_lock_front_buffer(struct gbm_surface *window) {
    struct gbm_bo *bo = NULL;
    _wpk_drm_mutex_lock(&surface_mutex);
    struct gbm_surface *s = find_surface_locked(window);
    if (s && s->public_live && s->front >= 0) {
        int index = s->front;
        s->front = -1;
        s->in_use[index] = 1;
        bo = s->bos[index];
    } else errno = EINVAL;
    _wpk_drm_mutex_unlock(&surface_mutex);
    return bo;
}
void gbm_surface_release_buffer(struct gbm_surface *window,struct gbm_bo *bo) {
    _wpk_drm_mutex_lock(&surface_mutex);
    struct gbm_surface *s=find_surface_locked(window);
    if(s&&bo){
        if(!s->public_live&&!s->window_owned){
            int cancel_state;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&cancel_state);
            int prepared=_wpk_drm_actor_prepare();
            struct gbm_surface *retired=retire_surface_locked(s,prepared,0,0,bo,NULL);
            _wpk_drm_mutex_unlock(&surface_mutex);
            free_surface(retired);pthread_setcancelstate(cancel_state,NULL);return;
        }
        /* Ordinary frame release keeps the existing metadata-only path; no
         * queue scan, actor preparation or cancellation work runs here. */
        for(unsigned i=0;i<WPK_GBM_SURFACE_BO_COUNT;i++)
            if(s->bos[i]==bo){s->in_use[i]=0;break;}
    }
    _wpk_drm_mutex_unlock(&surface_mutex);
}

int _wpk_gbm_surface_release_buffer_pending(struct wpk_gbm_front_hold *hold) {
    if(!hold){errno=EINVAL;return -1;}
    if(!hold->surface&&!hold->bo)return 0;
    _wpk_drm_mutex_lock(&surface_mutex);
    struct gbm_surface *s=find_surface_locked(hold->surface);
    unsigned slot=WPK_GBM_SURFACE_BO_COUNT;
    if(s&&hold->bo)for(unsigned i=0;i<WPK_GBM_SURFACE_BO_COUNT;i++)
        if(s->bos[i]==hold->bo&&s->in_use[i]){slot=i;break;}
    if(slot==WPK_GBM_SURFACE_BO_COUNT){
        _wpk_drm_mutex_unlock(&surface_mutex);
        fprintf(stderr,"Kandelo GBM: invalid pending front hold; custody retained\n");errno=EINVAL;return -1;
    }
    int retire=!s->public_live&&!s->window_owned;
    for(unsigned i=0;i<WPK_GBM_SURFACE_BO_COUNT;i++)if(i!=slot&&s->in_use[i])retire=0;
    if(!retire){
        /* A live public/window/other-front owner retains the ring. Release is
         * metadata only: no actor allocation, queue scan or device request. */
        _wpk_drm_owned_publication_begin();
        s->in_use[slot]=0;hold->surface=NULL;hold->bo=NULL;
        _wpk_drm_owned_publication_end();_wpk_drm_mutex_unlock(&surface_mutex);return 0;
    }
    int cancel_state;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&cancel_state);
    int prepared=_wpk_drm_actor_prepare();
    /* Clearing the capsule before release loses cleanup intent at fork;
     * clearing it afterwards replays a stale BO if userdata exits its thread.
     * Transfer the exact in_use hold and ring actor in one publication. */
    struct gbm_surface *retired=retire_surface_locked(s,prepared,0,0,hold->bo,hold);
    _wpk_drm_mutex_unlock(&surface_mutex);
    free_surface(retired);pthread_setcancelstate(cancel_state,NULL);return 0;
}

int gbm_surface_has_free_buffers(struct gbm_surface *window) {
    int available = 0;
    _wpk_drm_mutex_lock(&surface_mutex);
    struct gbm_surface *s = find_surface_locked(window);
    if (s && s->public_live)
        for (unsigned i = 0; i < WPK_GBM_SURFACE_BO_COUNT; ++i)
            if (!s->in_use[i] && (int)i != s->back && (int)i != s->front) { available = 1; break; }
    _wpk_drm_mutex_unlock(&surface_mutex);
    return available;
}
void gbm_surface_destroy(struct gbm_surface *window) {
    drain_retired_surfaces();
    int cancel_state;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&cancel_state);
    int prepared=_wpk_drm_actor_prepare();
    _wpk_drm_mutex_lock(&surface_mutex);
    struct gbm_surface *s=find_surface_locked(window),*retired=NULL;
    if(s&&s->public_live)retired=retire_surface_locked(s,prepared,1,0,NULL,NULL);
    _wpk_drm_mutex_unlock(&surface_mutex);
    free_surface(retired);pthread_setcancelstate(cancel_state,NULL);
}
