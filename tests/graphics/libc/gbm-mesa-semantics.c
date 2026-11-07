/* Actual GBM source against a DRM double, checking public behavior that
 * Mesa's libgbm (src/gbm/main/gbm.c + backends/dri/gbm_dri.c) defines:
 * user-data ownership, dma-buf import validation, FD_MODIFIER import,
 * legacy GBM_BO_FORMAT_* aliases, usage-flag rejection and out-of-range
 * plane accessors. Each case runs in its own process (argv[1]).
 *
 * The double models a PRIME descriptor as a real temporary file whose size
 * stands for the dma-buf size (Kandelo's PRIME lseek(SEEK_END) reports the
 * BO size, as Linux dma_buf_llseek does), and a GPU-tier BO as a handle
 * whose DRM_IOCTL_MODE_MAP_DUMB fails with EINVAL, as the kernel does. This
 * is source/API evidence, not SDK guest or kernel execution. */
#include <gbm.h>
#include "gbm_window.h"
#include "drm_owned.h"
#include <xf86drm.h>
#include <drm/drm_mode.h>
#include <drm/drm_fourcc.h>
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

int _wpk_gbm_surface_metadata(const void *, uint32_t *, uint32_t *, uint32_t *, uint32_t *);
int _wpk_gbm_device_metadata(const void *, int *, uint64_t *);

#define MAX_HANDLES 64
static struct wpk_drm_bo_info bo_metadata[64];
int graphics_gbm_native_bo_info(uint32_t handle,int fd,struct wpk_drm_bo_info *info){(void)fd;assert(handle<64);*info=bo_metadata[handle];return 0;}
static unsigned created;              /* last allocated GEM handle */
static unsigned live[MAX_HANDLES];    /* GEM handle reference: 1 while open */
static unsigned closes[MAX_HANDLES];  /* drmCloseBufferHandle calls per handle */
static int gpu_handle[MAX_HANDLES];   /* MAP_DUMB answers EINVAL (GPU tier) */
static uint32_t gpu_format[MAX_HANDLES]; /* the kernel's recorded GPU storage format */
static unsigned format_checks;
/* The kernel's GPU storage of a format (shared::dri::gpu_storage_format):
 * internal format * 2 + 1 when the format has no alpha; 0 when unknown. */
static uint32_t storage_of(uint32_t format) {
    switch (format) {
    case DRM_FORMAT_R8: return 0x8229 * 2;
    case DRM_FORMAT_GR88: return 0x822b * 2;
    case DRM_FORMAT_RGB565: return 0x8d62 * 2;
    case DRM_FORMAT_ARGB8888: case DRM_FORMAT_ABGR8888: return 0x8058 * 2;
    case DRM_FORMAT_XRGB8888: case DRM_FORMAT_XBGR8888: return 0x8058 * 2 + 1;
    case DRM_FORMAT_ARGB2101010: case DRM_FORMAT_ABGR2101010: return 0x8059 * 2;
    case DRM_FORMAT_XRGB2101010: case DRM_FORMAT_XBGR2101010: return 0x8059 * 2 + 1;
    case DRM_FORMAT_ABGR16161616F: return 0x881a * 2;
    case DRM_FORMAT_XBGR16161616F: return 0x881a * 2 + 1;
    default: return 0;
    }
}
static unsigned map_dumb_calls, allocations, gpu_allocations;
static int gpu_context;               /* WPK_CREATE_GPU_BO succeeds */
static uint32_t last_gpu_format, last_dumb_bpp, last_dumb_width, last_dumb_height;
static struct { int fd; uint32_t handle; } primes[8];

int graphics_gbm_munmap(void *address, size_t length) { return munmap(address, length); }

static uint32_t new_handle(int gpu) {
    assert(created + 1 < MAX_HANDLES);
    uint32_t handle = ++created;
    live[handle] = 1;
    gpu_handle[handle] = gpu;
    return handle;
}
/* A PRIME descriptor: a temporary file of `size` bytes naming `handle`. */
static int prime_fd(uint32_t handle, off_t size) {
    FILE *file = tmpfile(); assert(file);
    int fd = dup(fileno(file)); assert(fd >= 0);
    fclose(file);
    assert(!ftruncate(fd, size));
    /* A closed descriptor number may be reused: rebind it, never alias. */
    for (unsigned i = 0; i < sizeof primes / sizeof primes[0]; ++i) {
        if (primes[i].handle && primes[i].fd == fd) { primes[i].handle = handle; return fd; }
    }
    for (unsigned i = 0; i < sizeof primes / sizeof primes[0]; ++i) {
        if (!primes[i].handle) { primes[i].fd = fd; primes[i].handle = handle; return fd; }
    }
    assert(!"prime table full");
    return -1;
}
int drmIoctl(int fd, unsigned long request, void *data) {
    (void)fd;
    if (request == DRM_IOCTL_MODE_CREATE_DUMB) {
        struct drm_mode_create_dumb *d = data;
        ++allocations;
        last_dumb_bpp = d->bpp;
        last_dumb_width = d->width; last_dumb_height = d->height;
        /* The kernel's dumb rule: any nonzero bpp, rows rounded to 4 bytes. */
        d->handle = new_handle(0); d->pitch = ((d->width * d->bpp + 7) / 8 + 3) & ~3u;
        d->size = (uint64_t)d->pitch * d->height;
        bo_metadata[d->handle]=(struct wpk_drm_bo_info){d->size,d->width,d->height,d->pitch,0,0,0};
        return 0;
    }
    if (request == 0xc01064e0u) {
        /* WPK_CREATE_GPU_BO: no shared GL context unless a case provides
         * one. The kernel strides GPU storage by the format's cpp. */
        if (!gpu_context) { errno = ENOSYS; return -1; }
        uint32_t *words = data, cpp = 0;
        switch (words[2]) {
        case DRM_FORMAT_R8: cpp = 1; break;
        case DRM_FORMAT_GR88: case DRM_FORMAT_RGB565: cpp = 2; break;
        case DRM_FORMAT_ABGR16161616F: case DRM_FORMAT_XBGR16161616F: cpp = 8; break;
        default: cpp = 4; break;
        }
        ++gpu_allocations;
        last_gpu_format = words[2];
        uint32_t width=words[0],height=words[1];
        words[2] = new_handle(1);
        gpu_format[words[2]] = last_gpu_format;
        words[3] = (words[0] * cpp + 3) & ~3u;
        bo_metadata[words[2]]=(struct wpk_drm_bo_info){(uint64_t)words[3]*height,width,height,words[3],last_gpu_format,1,0};
        return 0;
    }
    if (request == DRM_IOCTL_PRIME_FD_TO_HANDLE) {
        struct drm_prime_handle *prime = data;
        for (unsigned i = 0; i < sizeof primes / sizeof primes[0]; ++i) {
            if (primes[i].handle && graphics_gbm_same_file(primes[i].fd,prime->fd)) {
                /* PRIME reimport on a file reuses its live GEM name. */
                if (!live[primes[i].handle]) live[primes[i].handle] = 1;
                prime->handle = primes[i].handle;
                off_t size=lseek(prime->fd,0,SEEK_END);assert(size>=0);bo_metadata[prime->handle].size=size;bo_metadata[prime->handle].tier=gpu_handle[prime->handle];
                return 0;
            }
        }
        errno = EBADF; return -1;
    }
    if (request == 0xc00864e4u) { /* WPK_CHECK_BO_FORMAT */
        uint32_t *words = data;
        ++format_checks;
        if (!words[0] || words[0] >= MAX_HANDLES || !live[words[0]]) { errno = ENOENT; return -1; }
        if (!gpu_handle[words[0]]) return 0;
        uint32_t real = storage_of(gpu_format[words[0]]), claimed = storage_of(words[1]);
        /* Same storage; a format without alpha needs storage without it. */
        if (!real || !claimed || real >> 1 != claimed >> 1 || ((claimed & 1) && !(real & 1))) {
            errno = EINVAL; return -1;
        }
        return 0;
    }
    if (request == DRM_IOCTL_PRIME_HANDLE_TO_FD) {
        /* A fresh descriptor naming the handle's object (its size is not
         * modelled for exports). */
        struct drm_prime_handle *prime = data;
        if (!prime->handle || prime->handle >= MAX_HANDLES || !live[prime->handle]) { errno = ENOENT; return -1; }
        prime->fd = prime_fd(prime->handle, 0);
        return 0;
    }
    if (request == DRM_IOCTL_MODE_MAP_DUMB) {
        struct drm_mode_map_dumb *d = data;
        ++map_dumb_calls;
        if (!d->handle || d->handle >= MAX_HANDLES || !live[d->handle]) { errno = ENOENT; return -1; }
        if (gpu_handle[d->handle]) { errno = EINVAL; return -1; }
        d->offset = (uint64_t)d->handle * (uint64_t)sysconf(_SC_PAGESIZE);
        return 0;
    }
    errno = ENOSYS; return -1;
}
int drmCloseBufferHandle(int fd, uint32_t handle) {
    (void)fd;
    assert(handle && handle < MAX_HANDLES && live[handle]);
    live[handle] = 0; closes[handle]++;
    return 0;
}

static FILE *device_file;
static struct gbm_device *open_device(void) {
    device_file = tmpfile(); assert(device_file);
    assert(!ftruncate(fileno(device_file), 4 * 1024 * 1024));
    struct gbm_device *device = gbm_create_device(fileno(device_file)); assert(device);
    return device;
}
static void close_device(struct gbm_device *device) {
    gbm_device_destroy(device);
    fclose(device_file);
    for (unsigned i = 1; i <= created; ++i) assert(!live[i]); /* no leaked GEM name */
}

/* gbm_bo_set_user_data only stores; the destructor runs from destroy. */
static unsigned destroyed_a, destroyed_b;
static void destroy_a(struct gbm_bo *bo, void *data) { (void)bo; assert(data == &destroyed_a); ++destroyed_a; }
static void destroy_b(struct gbm_bo *bo, void *data) { (void)bo; assert(data == &destroyed_b); ++destroyed_b; }
static void user_data_replace(void) {
    struct gbm_device *device = open_device();
    struct gbm_bo *bo = gbm_bo_create(device, 4, 3, GBM_FORMAT_XRGB8888, GBM_BO_USE_WRITE);
    assert(bo);
    gbm_bo_set_user_data(bo, &destroyed_a, destroy_a);
    gbm_bo_set_user_data(bo, &destroyed_b, destroy_b);
    assert(destroyed_a == 0 && destroyed_b == 0);
    assert(gbm_bo_get_user_data(bo) == &destroyed_b);
    gbm_bo_destroy(bo);
    assert(destroyed_a == 0 && destroyed_b == 1);
    /* A client that frees its data itself then clears the slot must not
     * see a second destructor call (Mesa-valid pattern). */
    bo = gbm_bo_create(device, 4, 3, GBM_FORMAT_XRGB8888, GBM_BO_USE_WRITE);
    assert(bo);
    gbm_bo_set_user_data(bo, &destroyed_a, destroy_a);
    gbm_bo_set_user_data(bo, NULL, NULL);
    assert(!gbm_bo_get_user_data(bo));
    gbm_bo_destroy(bo);
    assert(destroyed_a == 0 && destroyed_b == 1);
    close_device(device);
}

/* GBM_BO_IMPORT_FD trusts nothing the dma-buf cannot back. */
static void import_fd_bounds(void) {
    struct gbm_device *device = open_device();
    uint32_t handle = new_handle(0);
    int fd = prime_fd(handle, 48); /* exactly 4x3 XRGB8888 at pitch 16 */
    struct gbm_import_fd_data ok = {.fd = fd, .width = 4, .height = 3, .stride = 16,
        .format = GBM_FORMAT_XRGB8888};
    struct gbm_bo *held = gbm_bo_import(device, GBM_BO_IMPORT_FD, &ok, GBM_BO_USE_SCANOUT);
    assert(held && gbm_bo_get_stride(held) == 16 && gbm_bo_get_offset(held, 0) == 0);
    const struct gbm_import_fd_data bad[] = {
        {.fd = fd, .width = 4, .height = 4, .stride = 16, .format = GBM_FORMAT_XRGB8888},
        {.fd = fd, .width = 4, .height = 3, .stride = 32, .format = GBM_FORMAT_XRGB8888},
        {.fd = fd, .width = 4, .height = 3, .stride = 12, .format = GBM_FORMAT_XRGB8888},
        {.fd = fd, .width = 4, .height = 3, .stride = 0, .format = GBM_FORMAT_XRGB8888},
        {.fd = fd, .width = 4, .height = UINT32_MAX, .stride = UINT32_MAX,
            .format = GBM_FORMAT_XRGB8888},
    };
    for (unsigned i = 0; i < sizeof bad / sizeof bad[0]; ++i) {
        struct gbm_import_fd_data request = bad[i];
        errno = 0;
        assert(!gbm_bo_import(device, GBM_BO_IMPORT_FD, &request, 0) && errno == EINVAL);
        /* Rejection never closes the GEM name a live peer still owns. */
        assert(live[handle] && !closes[handle]);
    }
    gbm_bo_destroy(held);
    assert(!live[handle] && closes[handle] == 1);
    /* Without a peer, a rejected import releases the name it acquired. */
    struct gbm_import_fd_data tall = ok; tall.height = 4;
    errno = 0;
    assert(!gbm_bo_import(device, GBM_BO_IMPORT_FD, &tall, 0) && errno == EINVAL);
    assert(!live[handle] && closes[handle] == 2);
    close(fd);
    close_device(device);
}

/* Single-plane LINEAR (or implicit INVALID) dma-bufs import with their
 * offset; everything else is refused before any GEM name is acquired. */
static void import_fd_modifier(void) {
    struct gbm_device *device = open_device();
    uint32_t handle = new_handle(0);
    int fd = prime_fd(handle, 80); /* 16-byte header + 4x3 at pitch 16 + 16 spare */
    const uint64_t layouts[] = {DRM_FORMAT_MOD_LINEAR, DRM_FORMAT_MOD_INVALID};
    for (unsigned i = 0; i < 2; ++i) {
        struct gbm_import_fd_modifier_data data = {.width = 4, .height = 3,
            .format = GBM_FORMAT_ARGB8888, .num_fds = 1, .fds = {fd},
            .strides = {16}, .offsets = {16}, .modifier = layouts[i]};
        struct gbm_bo *bo = gbm_bo_import(device, GBM_BO_IMPORT_FD_MODIFIER, &data,
            GBM_BO_USE_SCANOUT | GBM_BO_USE_RENDERING);
        assert(bo);
        assert(gbm_bo_get_width(bo) == 4 && gbm_bo_get_height(bo) == 3);
        assert(gbm_bo_get_format(bo) == GBM_FORMAT_ARGB8888 && gbm_bo_get_bpp(bo) == 32);
        assert(gbm_bo_get_modifier(bo) == DRM_FORMAT_MOD_LINEAR);
        assert(gbm_bo_get_plane_count(bo) == 1);
        assert(gbm_bo_get_stride_for_plane(bo, 0) == 16 && gbm_bo_get_offset(bo, 0) == 16);
        assert(gbm_bo_get_handle_for_plane(bo, 0).u32 == handle);
        /* CPU views start at the plane offset, not the dma-buf start. */
        uint32_t stride = 0; void *token = NULL;
        uint32_t *pixels = gbm_bo_map(bo, 1, 2, 1, 1, GBM_BO_TRANSFER_WRITE, &stride, &token);
        assert(pixels && stride == 16);
        *pixels = 0xff00ff00u + i;
        gbm_bo_unmap(bo, token);
        uint32_t stored = 0;
        off_t at = (off_t)handle * sysconf(_SC_PAGESIZE) + 16 + 2 * 16 + 4;
        assert(pread(fileno(device_file), &stored, 4, at) == 4 && stored == 0xff00ff00u + i);
        gbm_bo_destroy(bo);
    }
    struct gbm_import_fd_modifier_data base = {.width = 4, .height = 3,
        .format = GBM_FORMAT_ARGB8888, .num_fds = 1, .fds = {fd},
        .strides = {16}, .offsets = {0}, .modifier = DRM_FORMAT_MOD_LINEAR};
    struct gbm_import_fd_modifier_data bad[8];
    for (unsigned i = 0; i < 8; ++i) bad[i] = base;
    bad[0].num_fds = 0;
    bad[1].num_fds = 2; bad[1].fds[1] = fd; bad[1].strides[1] = 16;
    bad[2].modifier = UINT64_C(0x0100000000000001); /* a tiled vendor layout */
    bad[3].offsets[0] = 48;                          /* 48 + 48 > 80 */
    bad[4].offsets[0] = -16;
    bad[5].strides[0] = -16;
    bad[6].strides[0] = 12;                          /* below 4 * cpp */
    bad[7].num_fds = GBM_MAX_PLANES + 1;
    unsigned closes_before = closes[handle];
    for (unsigned i = 0; i < 8; ++i) {
        errno = 0;
        assert(!gbm_bo_import(device, GBM_BO_IMPORT_FD_MODIFIER, &bad[i], 0) && errno == EINVAL);
    }
    assert(closes[handle] == closes_before + 1); /* only the offset overrun reached PRIME */
    /* A Wayland buffer import needs a wl_drm buffer, which nothing here
     * created. */
    errno = 0;
    assert(!gbm_bo_import(device, GBM_BO_IMPORT_WL_BUFFER, &base, 0) && errno == EINVAL);
    close(fd);
    close_device(device);
}

/* An imported GPU-tier BO is marked like a native GPU allocation: it is
 * unmappable, and a CPU-write usage request is refused at import. */
static void import_gpu_tier(void) {
    struct gbm_device *device = open_device();
    uint32_t handle = new_handle(1);
    gpu_format[handle] = GBM_FORMAT_XBGR8888;
    int fd = prime_fd(handle, 48);
    struct gbm_import_fd_data data = {.fd = fd, .width = 4, .height = 3, .stride = 16,
        .format = GBM_FORMAT_XBGR8888};
    errno = 0;
    assert(!gbm_bo_import(device, GBM_BO_IMPORT_FD, &data, GBM_BO_USE_WRITE) && errno == EINVAL);
    assert(!live[handle] && closes[handle] == 1);
    struct gbm_bo *bo = gbm_bo_import(device, GBM_BO_IMPORT_FD, &data,
        GBM_BO_USE_SCANOUT | GBM_BO_USE_RENDERING);
    assert(bo);
    unsigned calls = map_dumb_calls;
    uint32_t stride = 101; void *token = (void *)(uintptr_t)102;
    errno = 0;
    assert(!gbm_bo_map(bo, 0, 0, 4, 3, GBM_BO_TRANSFER_READ, &stride, &token) && errno == EINVAL);
    assert(stride == 101 && token == (void *)(uintptr_t)102);
    uint32_t pixel = 0;
    errno = 0;
    assert(gbm_bo_write(bo, &pixel, 4) == -1 && errno == EINVAL);
    assert(map_dumb_calls == calls); /* known unmappable: no kernel round trip */
    gbm_bo_destroy(bo);
    close(fd);
    close_device(device);
}

/* libEGL's half of GBM_BO_IMPORT_EGL_IMAGE: only images of the EGL display
 * initialized on `egl_device` (with its identity) export a plane, each time
 * as a fresh PRIME descriptor naming the image's GEM storage. */
/* A one-plane image (`plane`) or, with `chroma`, a two-plane NV12 image
 * whose planes are in `handle` and `chroma`. */
struct egl_image_plane { uint32_t width, height, format, stride, offset; };
struct egl_image_double { uint32_t handle; off_t size; struct egl_image_plane plane;
    uint32_t chroma; off_t chroma_size; uint32_t chroma_stride, chroma_offset; };
static const void *egl_device;
static uint64_t egl_identity;
static int egl_export_error, last_export_fd = -1;
int _wpk_egl_image_export_gbm(const void *image, const void *device, uint64_t identity,
                              struct wpk_gbm_image *planes) {
    const struct egl_image_double *source = image;
    if (egl_export_error) { errno = egl_export_error; return -1; }
    if (!source || device != egl_device || identity != egl_identity || !source->handle) {
        errno = EINVAL;
        return -1;
    }
    *planes = (struct wpk_gbm_image){.width = source->plane.width, .height = source->plane.height,
        .format = source->plane.format, .num_planes = source->chroma ? 2 : 1, .fds = {-1, -1, -1, -1},
        .strides = {source->plane.stride, source->chroma_stride},
        .offsets = {source->plane.offset, source->chroma_offset}};
    planes->fds[0] = last_export_fd = prime_fd(source->handle, source->size);
    if (source->chroma) planes->fds[1] = prime_fd(source->chroma, source->chroma_size);
    return 0;
}

/* Mesa gbm_dri_bo_import(GBM_BO_IMPORT_EGL_IMAGE): an image of this device's
 * EGL display becomes a bo sharing its storage, reporting the image's format,
 * extent, pitch and plane, with usage checked against that storage. */
static void import_egl_image(void) {
    struct gbm_device *device = open_device();
    int device_fd;
    assert(_wpk_gbm_device_metadata(device, &device_fd, &egl_identity));
    egl_device = device;
    struct egl_image_double gpu = {new_handle(1), 48,
        {.width = 4, .height = 3, .format = GBM_FORMAT_ABGR8888, .stride = 16}};
    gpu_format[gpu.handle] = GBM_FORMAT_ABGR8888;
    struct egl_image_double cpu = {new_handle(0), 96,
        {.width = 4, .height = 3, .format = GBM_FORMAT_XRGB8888, .stride = 16, .offset = 32}};
    struct egl_image_double unknown = {0};
    errno = 0;
    assert(!gbm_bo_import(device, GBM_BO_IMPORT_EGL_IMAGE, &unknown, 0) && errno == EINVAL);
    /* The GPU-tier image: unmappable storage, so a write usage is refused,
     * and the PRIME descriptor is released either way. */
    errno = 0;
    assert(!gbm_bo_import(device, GBM_BO_IMPORT_EGL_IMAGE, &gpu, GBM_BO_USE_WRITE) && errno == EINVAL);
    assert(fcntl(last_export_fd, F_GETFD) < 0 && !live[gpu.handle]);
    struct gbm_bo *bo = gbm_bo_import(device, GBM_BO_IMPORT_EGL_IMAGE, &gpu,
        GBM_BO_USE_SCANOUT | GBM_BO_USE_RENDERING);
    assert(bo && fcntl(last_export_fd, F_GETFD) < 0);
    assert(gbm_bo_get_handle(bo).u32 == gpu.handle && live[gpu.handle]);
    assert(gbm_bo_get_width(bo) == 4 && gbm_bo_get_height(bo) == 3);
    assert(gbm_bo_get_format(bo) == GBM_FORMAT_ABGR8888 && gbm_bo_get_bpp(bo) == 32);
    assert(gbm_bo_get_stride(bo) == 16 && gbm_bo_get_offset(bo, 0) == 0);
    assert(gbm_bo_get_modifier(bo) == DRM_FORMAT_MOD_LINEAR && gbm_bo_get_plane_count(bo) == 1);
    uint32_t stride = 0; void *token = NULL;
    errno = 0;
    assert(!gbm_bo_map(bo, 0, 0, 4, 3, GBM_BO_TRANSFER_READ, &stride, &token) && errno == EINVAL);
    gbm_bo_destroy(bo);
    assert(!live[gpu.handle]);
    /* The CPU-tier image keeps its plane offset: writes land in its rows. */
    bo = gbm_bo_import(device, GBM_BO_IMPORT_EGL_IMAGE, &cpu, GBM_BO_USE_WRITE | GBM_BO_USE_LINEAR);
    assert(bo && gbm_bo_get_offset(bo, 0) == 32 && gbm_bo_get_stride(bo) == 16);
    assert(gbm_bo_get_format(bo) == GBM_FORMAT_XRGB8888);
    const uint32_t pixel = 0x11223344u;
    assert(gbm_bo_write(bo, &pixel, sizeof pixel) == 0);
    uint32_t stored = 0;
    off_t at = (off_t)cpu.handle * sysconf(_SC_PAGESIZE) + 32;
    assert(pread(fileno(device_file), &stored, 4, at) == 4 && stored == pixel);
    gbm_bo_destroy(bo);
    /* A two-plane NV12 image: a bo with both planes' descriptors, as the
     * image's planes are in separate objects. */
    struct egl_image_double nv12 = {new_handle(0), 24, {.width = 4, .height = 4, .format = GBM_FORMAT_NV12,
        .stride = 4}, new_handle(0), 8, 4, 0};
    bo = gbm_bo_import(device, GBM_BO_IMPORT_EGL_IMAGE, &nv12, GBM_BO_USE_LINEAR);
    assert(bo && gbm_bo_get_plane_count(bo) == 2 && gbm_bo_get_format(bo) == GBM_FORMAT_NV12);
    assert(gbm_bo_get_handle_for_plane(bo, 1).u32 == nv12.chroma && gbm_bo_get_stride_for_plane(bo, 1) == 4);
    gbm_bo_destroy(bo);
    assert(!live[nv12.handle] && !live[nv12.chroma]);
    /* Geometry the storage cannot back is refused like any dma-buf. */
    cpu.size = 64;
    errno = 0;
    assert(!gbm_bo_import(device, GBM_BO_IMPORT_EGL_IMAGE, &cpu, 0) && errno == EINVAL);
    /* EGL's own failure is reported as is. */
    egl_export_error = EMFILE;
    errno = 0;
    assert(!gbm_bo_import(device, GBM_BO_IMPORT_EGL_IMAGE, &gpu, 0) && errno == EMFILE);
    egl_export_error = 0;
    /* Another device's display does not own these images. */
    struct gbm_device *other = gbm_create_device(fileno(device_file));
    assert(other);
    errno = 0;
    assert(!gbm_bo_import(other, GBM_BO_IMPORT_EGL_IMAGE, &gpu, 0) && errno == EINVAL);
    gbm_device_destroy(other);
    close_device(device);
}

/* Unsupported usage bits fail; they are never silently granted. */
static void import_usage(void) {
    struct gbm_device *device = open_device();
    uint32_t handle = new_handle(0);
    int fd = prime_fd(handle, 48);
    struct gbm_import_fd_data data = {.fd = fd, .width = 4, .height = 3, .stride = 16,
        .format = GBM_FORMAT_XRGB8888};
    const uint32_t refused[] = {GBM_BO_USE_PROTECTED,
        GBM_BO_FIXED_COMPRESSION_DEFAULT, 1u << 20};
    for (unsigned i = 0; i < sizeof refused / sizeof refused[0]; ++i) {
        errno = 0;
        assert(!gbm_bo_import(device, GBM_BO_IMPORT_FD, &data,
            GBM_BO_USE_SCANOUT | refused[i]) && errno == EINVAL);
    }
    struct gbm_bo *bo = gbm_bo_import(device, GBM_BO_IMPORT_FD, &data,
        GBM_BO_USE_SCANOUT | GBM_BO_USE_CURSOR | GBM_BO_USE_RENDERING |
        GBM_BO_USE_WRITE | GBM_BO_USE_LINEAR | GBM_BO_USE_FRONT_RENDERING);
    assert(bo);
    assert(gbm_bo_write(bo, &data, 4) == 0); /* CPU tier: write honored */
    gbm_bo_destroy(bo);
    close(fd);
    close_device(device);
}

/* Mesa canonicalizes GBM_BO_FORMAT_{XRGB,ARGB}8888 (0 and 1) at every
 * entry point and reports only the fourcc. */
static void legacy_formats(void) {
    struct gbm_device *device = open_device();
    const uint32_t legacy[] = {GBM_BO_FORMAT_XRGB8888, GBM_BO_FORMAT_ARGB8888};
    const uint32_t fourcc[] = {GBM_FORMAT_XRGB8888, GBM_FORMAT_ARGB8888};
    for (unsigned i = 0; i < 2; ++i) {
        assert(gbm_device_is_format_supported(device, legacy[i], GBM_BO_USE_SCANOUT) == 1);
        struct gbm_bo *bo = gbm_bo_create(device, 4, 3, legacy[i], GBM_BO_USE_WRITE);
        assert(bo && gbm_bo_get_format(bo) == fourcc[i] && gbm_bo_get_bpp(bo) == 32);
        gbm_bo_destroy(bo);
        const uint64_t linear = DRM_FORMAT_MOD_LINEAR;
        bo = gbm_bo_create_with_modifiers2(device, 4, 3, legacy[i], &linear, 1,
            GBM_BO_USE_SCANOUT);
        assert(bo && gbm_bo_get_format(bo) == fourcc[i]);
        gbm_bo_destroy(bo);
        struct gbm_surface *surface = gbm_surface_create(device, 4, 3, legacy[i],
            GBM_BO_USE_SCANOUT);
        assert(surface);
        uint32_t width, height, format = 0, flags;
        assert(_wpk_gbm_surface_metadata(surface, &width, &height, &format, &flags));
        assert(format == fourcc[i]);
        gbm_surface_destroy(surface);
        uint32_t handle = new_handle(0);
        int fd = prime_fd(handle, 48);
        struct gbm_import_fd_data data = {.fd = fd, .width = 4, .height = 3, .stride = 16,
            .format = legacy[i]};
        bo = gbm_bo_import(device, GBM_BO_IMPORT_FD, &data, 0);
        assert(bo && gbm_bo_get_format(bo) == fourcc[i]);
        gbm_bo_destroy(bo);
        struct gbm_import_fd_modifier_data modifier = {.width = 4, .height = 3,
            .format = legacy[i], .num_fds = 1, .fds = {fd}, .strides = {16},
            .modifier = DRM_FORMAT_MOD_LINEAR};
        bo = gbm_bo_import(device, GBM_BO_IMPORT_FD_MODIFIER, &modifier, 0);
        assert(bo && gbm_bo_get_format(bo) == fourcc[i]);
        gbm_bo_destroy(bo);
        close(fd);
    }
    close_device(device);
}

/* Allocation refuses usages Kandelo cannot provide (protected content,
 * fixed-rate compression, unknown bits). */
static void usage_flags(void) {
    struct gbm_device *device = open_device();
    const uint32_t refused[] = {GBM_BO_USE_PROTECTED,
        GBM_BO_FIXED_COMPRESSION_DEFAULT, GBM_BO_FIXED_COMPRESSION_12BPC, 1u << 20};
    const uint64_t linear = DRM_FORMAT_MOD_LINEAR;
    unsigned before = allocations;
    for (unsigned i = 0; i < sizeof refused / sizeof refused[0]; ++i) {
        uint32_t flags = GBM_BO_USE_SCANOUT | refused[i];
        errno = 0;
        assert(!gbm_bo_create(device, 4, 3, GBM_FORMAT_XRGB8888, flags) && errno == EINVAL);
        errno = 0;
        assert(!gbm_bo_create_with_modifiers2(device, 4, 3, GBM_FORMAT_XRGB8888,
            &linear, 1, flags) && errno == EINVAL);
        errno = 0;
        assert(!gbm_surface_create(device, 4, 3, GBM_FORMAT_XRGB8888, flags) && errno == EINVAL);
        errno = 0;
        assert(!gbm_surface_create_with_modifiers2(device, 4, 3, GBM_FORMAT_XRGB8888,
            &linear, 1, flags) && errno == EINVAL);
        assert(!gbm_device_is_format_supported(device, GBM_FORMAT_XRGB8888, flags));
    }
    assert(allocations == before);
    /* Front-buffer rendering (gbm.h: "disable framebuffer compression") is
     * satisfied by every buffer: none has compression metadata, and scanout
     * presents current storage without a flip. Both tiers grant it. */
    const uint32_t front[] = {GBM_BO_USE_SCANOUT | GBM_BO_USE_WRITE,
        GBM_BO_USE_SCANOUT | GBM_BO_USE_RENDERING};
    for (unsigned i = 0; i < 2; ++i) {
        uint32_t flags = front[i] | GBM_BO_USE_FRONT_RENDERING;
        assert(gbm_device_is_format_supported(device, GBM_FORMAT_XRGB8888, flags) == 1);
        struct gbm_bo *bo = gbm_bo_create(device, 4, 3, GBM_FORMAT_XRGB8888, flags);
        assert(bo);
        gbm_bo_destroy(bo);
        bo = gbm_bo_create_with_modifiers2(device, 4, 3, GBM_FORMAT_XRGB8888, &linear, 1, flags);
        assert(bo);
        gbm_bo_destroy(bo);
        struct gbm_surface *surface = gbm_surface_create(device, 4, 3, GBM_FORMAT_XRGB8888, flags);
        assert(surface);
        gbm_surface_destroy(surface);
    }
    /* Format support follows the planes that scan the buffer out: the
     * kernel cursor plane takes ARGB8888 only, and (as Mesa's DRI backend
     * reports) no format is both a cursor and a render target. */
    assert(gbm_device_is_format_supported(device, GBM_FORMAT_ARGB8888, GBM_BO_USE_CURSOR) == 1);
    assert(gbm_device_is_format_supported(device, GBM_FORMAT_ARGB8888,
        GBM_BO_USE_CURSOR | GBM_BO_USE_WRITE) == 1);
    assert(gbm_device_is_format_supported(device, GBM_FORMAT_XRGB8888, GBM_BO_USE_CURSOR) == 0);
    assert(gbm_device_is_format_supported(device, GBM_FORMAT_ARGB8888,
        GBM_BO_USE_CURSOR | GBM_BO_USE_RENDERING) == 0);
    const uint32_t scanout[] = {GBM_FORMAT_XRGB8888, GBM_FORMAT_ARGB8888,
        GBM_FORMAT_XBGR8888, GBM_FORMAT_ABGR8888};
    for (unsigned i = 0; i < 4; ++i)
        assert(gbm_device_is_format_supported(device, scanout[i],
            GBM_BO_USE_SCANOUT | GBM_BO_USE_RENDERING | GBM_BO_USE_LINEAR) == 1);
    close_device(device);
}

/* RGB565, the 16-bpp format the primary plane scans out: CPU-tier (dumb)
 * storage for scanout, write and linear usages, and a GL render target in
 * both tiers (an RGB565 texture, or a CPU buffer mirrored through one); not
 * a cursor (the cursor plane is ARGB8888) or an EGL window (configs are
 * 8888). */
static void rgb565(void) {
    struct gbm_device *device = open_device();
    assert(gbm_device_is_format_supported(device, GBM_FORMAT_RGB565,
        GBM_BO_USE_SCANOUT | GBM_BO_USE_WRITE | GBM_BO_USE_LINEAR) == 1);
    assert(gbm_device_is_format_supported(device, GBM_FORMAT_RGB565, GBM_BO_USE_RENDERING) == 1);
    assert(gbm_device_is_format_supported(device, GBM_FORMAT_RGB565,
        GBM_BO_USE_SCANOUT | GBM_BO_USE_RENDERING) == 1);
    assert(gbm_device_is_format_supported(device, GBM_FORMAT_RGB565, GBM_BO_USE_CURSOR) == 0);
    struct gbm_bo *bo = gbm_bo_create(device, 5, 3, GBM_FORMAT_RGB565,
        GBM_BO_USE_SCANOUT | GBM_BO_USE_WRITE);
    assert(bo && gbm_bo_get_bpp(bo) == 16 && gbm_bo_get_stride(bo) == 12);
    assert(gbm_bo_get_format(bo) == GBM_FORMAT_RGB565);
    gbm_bo_destroy(bo);
    gpu_context = 1;
    bo = gbm_bo_create(device, 5, 3, GBM_FORMAT_RGB565, GBM_BO_USE_RENDERING);
    assert(bo && last_gpu_format == GBM_FORMAT_RGB565 && gbm_bo_get_stride(bo) == 12);
    gbm_bo_destroy(bo);
    errno = 0;
    assert(!gbm_surface_create(device, 5, 3, GBM_FORMAT_RGB565, GBM_BO_USE_SCANOUT | GBM_BO_USE_RENDERING)
        && errno == EINVAL);
    assert(gbm_device_get_format_modifier_plane_count(device, GBM_FORMAT_RGB565, DRM_FORMAT_MOD_LINEAR) == 1);
    close_device(device);
}

/* The single-plane formats clients use for planes and render targets
 * (wlroots' R8/GR88 YUV planes and FP16 render buffers, 10-bit
 * framebuffers): each has its drm_format_info bpp and LINEAR stride, CPU
 * storage, a render target in its own format, and is reported for exactly
 * the usages it can serve. */
static void widened_formats(void) {
    struct gbm_device *device = open_device();
    /* scanout: every format scans out on the primary plane (R8 and GR88
     * with their missing channels zero; 10-bit and half-float values
     * reduced to the 8-bpc output). */
    static const struct { uint32_t format, bpp, stride; int scanout; } formats[] = {
        {GBM_FORMAT_R8, 8, 8, 1}, {GBM_FORMAT_GR88, 16, 12, 1},
        {GBM_FORMAT_XRGB2101010, 32, 20, 1}, {GBM_FORMAT_ARGB2101010, 32, 20, 1},
        {GBM_FORMAT_XBGR2101010, 32, 20, 1}, {GBM_FORMAT_ABGR2101010, 32, 20, 1},
        {GBM_FORMAT_XBGR16161616F, 64, 40, 1}, {GBM_FORMAT_ABGR16161616F, 64, 40, 1},
    };
    const uint64_t linear = DRM_FORMAT_MOD_LINEAR;
    for (unsigned i = 0; i < sizeof formats / sizeof formats[0]; ++i) {
        uint32_t format = formats[i].format;
        /* CPU storage: a dumb buffer of the format's bpp. */
        assert(gbm_device_is_format_supported(device, format,
            GBM_BO_USE_WRITE | GBM_BO_USE_LINEAR | GBM_BO_USE_RENDERING) == 1);
        struct gbm_bo *bo = gbm_bo_create(device, 5, 3, format,
            GBM_BO_USE_WRITE | GBM_BO_USE_LINEAR | GBM_BO_USE_RENDERING);
        assert(bo && last_dumb_bpp == formats[i].bpp);
        assert(gbm_bo_get_bpp(bo) == formats[i].bpp && gbm_bo_get_stride(bo) == formats[i].stride);
        assert(gbm_bo_get_format(bo) == format && gbm_bo_get_plane_count(bo) == 1);
        gbm_bo_destroy(bo);
        /* A render-only buffer is GPU storage of the format through both
         * entry points, and CPU storage without a GL renderer. */
        gpu_context = 1;
        assert(gbm_device_is_format_supported(device, format, GBM_BO_USE_RENDERING) == 1);
        bo = gbm_bo_create(device, 5, 3, format, GBM_BO_USE_RENDERING);
        assert(bo && last_gpu_format == format && gbm_bo_get_stride(bo) == formats[i].stride);
        assert(gbm_bo_get_bpp(bo) == formats[i].bpp);
        gbm_bo_destroy(bo);
        bo = gbm_bo_create_with_modifiers2(device, 5, 3, format, &linear, 1, GBM_BO_USE_RENDERING);
        assert(bo && last_gpu_format == format);
        gbm_bo_destroy(bo);
        gpu_context = 0;
        bo = gbm_bo_create(device, 5, 3, format, GBM_BO_USE_RENDERING);
        assert(bo && last_dumb_bpp == formats[i].bpp);
        gbm_bo_destroy(bo);
        /* The primary plane exactly where it shows the format exactly. */
        assert(gbm_device_is_format_supported(device, format, GBM_BO_USE_SCANOUT) == formats[i].scanout);
        errno = 0;
        bo = gbm_bo_create(device, 5, 3, format, GBM_BO_USE_SCANOUT);
        assert(formats[i].scanout ? bo != NULL : (!bo && errno == EINVAL));
        if (bo) gbm_bo_destroy(bo);
        gpu_context = 1;
        errno = 0;
        bo = gbm_bo_create_with_modifiers2(device, 5, 3, format, &linear, 1,
            GBM_BO_USE_SCANOUT | GBM_BO_USE_RENDERING);
        assert(formats[i].scanout ? bo && last_gpu_format == format : (!bo && errno == EINVAL));
        if (bo) gbm_bo_destroy(bo);
        gpu_context = 0;
        /* No cursor or EGL window. */
        assert(gbm_device_is_format_supported(device, format, GBM_BO_USE_CURSOR) == 0);
        errno = 0;
        assert(!gbm_surface_create(device, 5, 3, format, GBM_BO_USE_RENDERING) && errno == EINVAL);
        assert(gbm_device_get_format_modifier_plane_count(device, format, DRM_FORMAT_MOD_LINEAR) == 1);
        /* dma-buf import: the stride must hold a row of this format. */
        bo = gbm_bo_create(device, 5, 3, format, GBM_BO_USE_LINEAR);
        assert(bo);
        int fd = prime_fd(gbm_bo_get_handle(bo).u32, (off_t)formats[i].stride * 3);
        struct gbm_import_fd_data data = {.fd = fd, .width = 5, .height = 3,
            .stride = formats[i].stride, .format = format};
        struct gbm_bo *imported = gbm_bo_import(device, GBM_BO_IMPORT_FD, &data,
            GBM_BO_USE_LINEAR | GBM_BO_USE_RENDERING);
        assert(imported && gbm_bo_get_bpp(imported) == formats[i].bpp && gbm_bo_get_format(imported) == format);
        gbm_bo_destroy(imported);
        data.stride = 5 * formats[i].bpp / 8 - 1;
        errno = 0;
        assert(!gbm_bo_import(device, GBM_BO_IMPORT_FD, &data, GBM_BO_USE_LINEAR) && errno == EINVAL);
        data.stride = formats[i].stride;
        errno = 0;
        imported = gbm_bo_import(device, GBM_BO_IMPORT_FD, &data, GBM_BO_USE_SCANOUT);
        assert(formats[i].scanout ? imported != NULL : (!imported && errno == EINVAL));
        if (imported) gbm_bo_destroy(imported);
        close(fd);
        gbm_bo_destroy(bo);
    }
    close_device(device);
}

/* A GPU-tier buffer is a texture of the format it was made with (the
 * kernel records it): a dma-buf import must claim a format naming that
 * storage. Same-size formats with other storage (GR88 vs RGB565, ABGR8888
 * vs ABGR2101010) and a format without alpha over storage with alpha fail
 * with EINVAL; channel order alone (ARGB vs ABGR) is not observable on a
 * GPU buffer. CPU-tier bytes take any format. */
static void import_gpu_format(void) {
    struct gbm_device *device = open_device();
    gpu_context = 1;
    static const struct { uint32_t real, claimed; int ok; } cases[] = {
        {GBM_FORMAT_GR88, GBM_FORMAT_GR88, 1}, {GBM_FORMAT_GR88, GBM_FORMAT_RGB565, 0},
        {GBM_FORMAT_RGB565, GBM_FORMAT_GR88, 0}, {GBM_FORMAT_ABGR8888, GBM_FORMAT_ARGB8888, 1},
        {GBM_FORMAT_ABGR8888, GBM_FORMAT_ABGR2101010, 0}, {GBM_FORMAT_ARGB8888, GBM_FORMAT_XRGB8888, 0},
        {GBM_FORMAT_XRGB8888, GBM_FORMAT_ARGB8888, 1}, {GBM_FORMAT_ABGR16161616F, GBM_FORMAT_XBGR16161616F, 0},
    };
    for (unsigned i = 0; i < sizeof cases / sizeof cases[0]; ++i) {
        struct gbm_bo *bo = gbm_bo_create(device, 4, 4, cases[i].real, GBM_BO_USE_RENDERING);
        assert(bo && gpu_handle[gbm_bo_get_handle(bo).u32]);
        int fd = prime_fd(gbm_bo_get_handle(bo).u32, (off_t)gbm_bo_get_stride(bo) * 4);
        uint32_t cpp = gbm_bo_get_bpp(bo) / 8;
        struct gbm_import_fd_data data = {.fd = fd, .width = 4, .height = 4,
            .stride = gbm_bo_get_stride(bo), .format = cases[i].claimed};
        (void)cpp;
        unsigned checks = format_checks;
        errno = 0;
        struct gbm_bo *imported = gbm_bo_import(device, GBM_BO_IMPORT_FD, &data, GBM_BO_USE_RENDERING);
        assert(format_checks == checks + 1);
        if (cases[i].ok) {
            assert(imported && gbm_bo_get_format(imported) == cases[i].claimed);
            gbm_bo_destroy(imported);
        } else {
            assert(!imported && errno == EINVAL);
        }
        close(fd);
        gbm_bo_destroy(bo);
    }
    /* A CPU buffer's bytes are reinterpreted without a kernel check. */
    struct gbm_bo *bo = gbm_bo_create(device, 4, 4, GBM_FORMAT_GR88, GBM_BO_USE_LINEAR);
    int fd = prime_fd(gbm_bo_get_handle(bo).u32, 64);
    struct gbm_import_fd_data data = {.fd = fd, .width = 4, .height = 4, .stride = 8,
        .format = GBM_FORMAT_RGB565};
    unsigned checks = format_checks;
    struct gbm_bo *imported = gbm_bo_import(device, GBM_BO_IMPORT_FD, &data, GBM_BO_USE_LINEAR);
    assert(imported && format_checks == checks);
    gbm_bo_destroy(imported);
    close(fd);
    gbm_bo_destroy(bo);
    close_device(device);
}

/* Multi-plane and packed YUV buffers (NV12, NV21, YUV420, YVU420, YUYV,
 * UYVY, P010): one linear CPU-tier object holding every plane, laid out
 * with drm_format_info's subsampled plane sizes and 4-byte row alignment,
 * and reported plane by plane. They are sampled through EGLImages only:
 * no YUV render target, scanout plane or cursor exists, so those usages
 * fail. */
static void yuv_buffers(void) {
    struct gbm_device *device = open_device();
    static const struct { uint32_t format; unsigned planes; uint32_t strides[3], offsets[3], size; } layouts[] = {
        {GBM_FORMAT_NV12, 2, {8, 8}, {0, 24}, 40},
        {GBM_FORMAT_NV21, 2, {8, 8}, {0, 24}, 40},
        {GBM_FORMAT_YUV420, 3, {8, 4, 4}, {0, 24, 32}, 40},
        {GBM_FORMAT_YVU420, 3, {8, 4, 4}, {0, 24, 32}, 40},
        {GBM_FORMAT_YUYV, 1, {12}, {0}, 36},  /* 5 pixels: three Y0,Cb,Y1,Cr groups */
        {GBM_FORMAT_UYVY, 1, {12}, {0}, 36},
        {DRM_FORMAT_P010, 2, {12, 12}, {0, 36}, 60},
    };
    const uint64_t linear = DRM_FORMAT_MOD_LINEAR;
    for (unsigned i = 0; i < sizeof layouts / sizeof layouts[0]; ++i) {
        uint32_t format = layouts[i].format;
        assert(gbm_device_is_format_supported(device, format, GBM_BO_USE_LINEAR | GBM_BO_USE_WRITE) == 1);
        assert(gbm_device_is_format_supported(device, format, GBM_BO_USE_RENDERING) == 0);
        assert(gbm_device_is_format_supported(device, format, GBM_BO_USE_SCANOUT) == 0);
        assert(gbm_device_is_format_supported(device, format, GBM_BO_USE_CURSOR) == 0);
        assert(gbm_device_get_format_modifier_plane_count(device, format, linear) == (int)layouts[i].planes);
        unsigned before = allocations;
        gpu_context = 1;
        const uint32_t refused[] = {GBM_BO_USE_RENDERING, GBM_BO_USE_SCANOUT, GBM_BO_USE_CURSOR};
        for (unsigned j = 0; j < 3; ++j) {
            errno = 0;
            assert(!gbm_bo_create(device, 5, 3, format, refused[j]) && errno == EINVAL);
        }
        errno = 0;
        assert(!gbm_bo_create_with_modifiers(device, 5, 3, format, &linear, 1) && errno == EINVAL);
        errno = 0;
        assert(!gbm_surface_create(device, 5, 3, format, GBM_BO_USE_LINEAR) && errno == EINVAL);
        assert(allocations == before && !gpu_allocations);
        gpu_context = 0;
        struct gbm_bo *bo = gbm_bo_create_with_modifiers2(device, 5, 3, format, &linear, 1,
            GBM_BO_USE_WRITE);
        assert(bo && allocations == before + 1 && last_dumb_bpp == 8);
        /* One dumb object at least as large as the layout. */
        assert((uint64_t)last_dumb_width * last_dumb_height >= layouts[i].size);
        assert(gbm_bo_get_format(bo) == format && gbm_bo_get_modifier(bo) == linear);
        assert(gbm_bo_get_bpp(bo) == 0); /* Mesa: no single bpp for YUV */
        assert(gbm_bo_get_plane_count(bo) == (int)layouts[i].planes);
        assert(gbm_bo_get_stride(bo) == layouts[i].strides[0]);
        for (unsigned plane = 0; plane < layouts[i].planes; ++plane) {
            assert(gbm_bo_get_stride_for_plane(bo, (int)plane) == layouts[i].strides[plane]);
            assert(gbm_bo_get_offset(bo, (int)plane) == layouts[i].offsets[plane]);
            assert(gbm_bo_get_handle_for_plane(bo, (int)plane).u32 == gbm_bo_get_handle(bo).u32);
            int fd = gbm_bo_get_fd_for_plane(bo, (int)plane);
            assert(fd >= 0);
            close(fd);
        }
        errno = 0;
        assert(gbm_bo_get_handle_for_plane(bo, (int)layouts[i].planes).s32 == -1 && errno == EINVAL);
        /* gbm_bo_write copies raw bytes into the object: every plane. */
        uint8_t bytes[60];
        for (unsigned k = 0; k < sizeof bytes; ++k) bytes[k] = (uint8_t)(k * 3 + i);
        assert(gbm_bo_write(bo, bytes, layouts[i].size) == 0);
        uint8_t stored[60] = {0};
        off_t at = (off_t)gbm_bo_get_handle(bo).u32 * sysconf(_SC_PAGESIZE);
        assert(pread(fileno(device_file), stored, layouts[i].size, at) == (ssize_t)layouts[i].size);
        assert(!memcmp(stored, bytes, layouts[i].size));
        errno = 0;
        assert(gbm_bo_write(bo, bytes, layouts[i].size + 1) == -1 && errno == EINVAL);
        /* gbm_bo_map maps the first plane in its own samples. */
        uint32_t stride = 0; void *token = NULL;
        uint8_t *luma = gbm_bo_map(bo, 1, 2, 1, 1, GBM_BO_TRANSFER_WRITE, &stride, &token);
        assert(luma && stride == layouts[i].strides[0]);
        *luma = 0xa5;
        gbm_bo_unmap(bo, token);
        uint8_t value = 0;
        uint32_t cpp = format == DRM_FORMAT_P010 || format == GBM_FORMAT_YUYV || format == GBM_FORMAT_UYVY ? 2 : 1;
        assert(pread(fileno(device_file), &value, 1, at + 2 * stride + cpp) == 1 && value == 0xa5);
        gbm_bo_destroy(bo);
    }
    close_device(device);
}

/* GBM_BO_IMPORT_FD_MODIFIER describes every plane: one fd, stride and offset
 * per plane, the fds naming one object or several, each plane checked
 * against the real size of its own object. */
static void import_yuv(void) {
    struct gbm_device *device = open_device();
    uint32_t handle = new_handle(0);
    int fd = prime_fd(handle, 40); /* 5x3 NV12: Y 8x3 at 0, CbCr 8x2 at 24 */
    struct gbm_import_fd_modifier_data base = {.width = 5, .height = 3, .format = GBM_FORMAT_NV12,
        .num_fds = 2, .fds = {fd, fd}, .strides = {8, 8}, .offsets = {0, 24},
        .modifier = DRM_FORMAT_MOD_LINEAR};
    struct gbm_bo *bo = gbm_bo_import(device, GBM_BO_IMPORT_FD_MODIFIER, &base, GBM_BO_USE_LINEAR);
    assert(bo && gbm_bo_get_plane_count(bo) == 2 && gbm_bo_get_bpp(bo) == 0);
    assert(gbm_bo_get_handle_for_plane(bo, 1).u32 == handle && gbm_bo_get_offset(bo, 1) == 24);
    assert(gbm_bo_get_stride_for_plane(bo, 1) == 8);
    gbm_bo_destroy(bo);
    assert(!live[handle] && closes[handle] == 1); /* one shared GEM name, closed once */
    /* Planes in separate objects: each name is held and released. */
    uint32_t chroma = new_handle(0);
    int chroma_fd = prime_fd(chroma, 16);
    struct gbm_import_fd_modifier_data split = base;
    split.fds[1] = chroma_fd; split.offsets[1] = 0;
    bo = gbm_bo_import(device, GBM_BO_IMPORT_FD_MODIFIER, &split, 0);
    assert(bo && gbm_bo_get_handle_for_plane(bo, 0).u32 == handle);
    assert(gbm_bo_get_handle_for_plane(bo, 1).u32 == chroma && live[handle] && live[chroma]);
    gbm_bo_destroy(bo);
    assert(!live[handle] && !live[chroma] && closes[chroma] == 1);
    /* A YUV plane is never rendered to or scanned out. */
    const uint32_t refused[] = {GBM_BO_USE_RENDERING, GBM_BO_USE_SCANOUT};
    for (unsigned i = 0; i < 2; ++i) {
        errno = 0;
        assert(!gbm_bo_import(device, GBM_BO_IMPORT_FD_MODIFIER, &base, refused[i]) && errno == EINVAL);
    }
    struct gbm_import_fd_modifier_data bad[6];
    for (unsigned i = 0; i < 6; ++i) bad[i] = base;
    bad[0].num_fds = 1;                      /* NV12 has two planes */
    bad[1].num_fds = 3; bad[1].fds[2] = fd; bad[1].strides[2] = 8;
    bad[2].strides[1] = 5;                   /* below 3 CbCr pairs */
    bad[3].offsets[1] = 25;                  /* 25 + 8 * 2 > 40 */
    bad[4].fds[1] = chroma_fd; bad[4].offsets[1] = 1; /* 1 + 16 > 16 */
    bad[5].offsets[1] = -8;
    for (unsigned i = 0; i < 6; ++i) {
        errno = 0;
        assert(!gbm_bo_import(device, GBM_BO_IMPORT_FD_MODIFIER, &bad[i], 0) && errno == EINVAL);
        assert(!live[handle] && !live[chroma]); /* no name outlives a refusal */
    }
    /* GPU-tier planes are textures of the plane formats: NV12 luma R8 and
     * chroma GR88, each at its object's origin. */
    uint32_t gpu = new_handle(1), gpu_chroma = new_handle(1);
    gpu_format[gpu] = DRM_FORMAT_R8; gpu_format[gpu_chroma] = DRM_FORMAT_GR88;
    int gpu_fd = prime_fd(gpu, 40), gpu_chroma_fd = prime_fd(gpu_chroma, 40);
    struct gbm_import_fd_modifier_data texture = base;
    texture.fds[0] = gpu_fd; texture.fds[1] = gpu_chroma_fd; texture.offsets[1] = 0;
    unsigned checks = format_checks;
    bo = gbm_bo_import(device, GBM_BO_IMPORT_FD_MODIFIER, &texture, 0);
    assert(bo && format_checks == checks + 2 && gbm_bo_get_handle_for_plane(bo, 1).u32 == gpu_chroma);
    gbm_bo_destroy(bo);
    assert(!live[gpu] && !live[gpu_chroma]);
    /* gbm_bo_write needs CPU bytes no GPU plane has, even beside a CPU one. */
    struct gbm_import_fd_modifier_data mixed = texture;
    mixed.fds[0] = fd;
    errno = 0;
    assert(!gbm_bo_import(device, GBM_BO_IMPORT_FD_MODIFIER, &mixed, GBM_BO_USE_WRITE) && errno == EINVAL);
    assert(!live[handle] && !live[gpu_chroma]);
    struct gbm_import_fd_modifier_data wrong[3] = {texture, texture, texture};
    wrong[0].fds[0] = gpu_chroma_fd;   /* a GR88 texture is not a luma plane */
    wrong[1].fds[1] = gpu_fd;          /* nor is an R8 texture a chroma plane */
    wrong[2].offsets[1] = 24;          /* a texture has no byte offsets */
    for (unsigned i = 0; i < 3; ++i) {
        errno = 0;
        assert(!gbm_bo_import(device, GBM_BO_IMPORT_FD_MODIFIER, &wrong[i], 0) && errno == EINVAL);
        assert(!live[gpu] && !live[gpu_chroma]);
    }
    /* GBM_BO_IMPORT_FD names one plane: a packed YUV format, not NV12. */
    struct gbm_import_fd_data single = {.fd = fd, .width = 5, .height = 3, .stride = 8,
        .format = GBM_FORMAT_NV12};
    errno = 0;
    assert(!gbm_bo_import(device, GBM_BO_IMPORT_FD, &single, 0) && errno == EINVAL);
    single.format = GBM_FORMAT_YUYV; single.stride = 12;
    bo = gbm_bo_import(device, GBM_BO_IMPORT_FD, &single, GBM_BO_USE_LINEAR);
    assert(bo && gbm_bo_get_plane_count(bo) == 1 && gbm_bo_get_format(bo) == GBM_FORMAT_YUYV);
    gbm_bo_destroy(bo);
    single.stride = 10; /* 5 pixels end inside a third Y0,Cb,Y1,Cr group */
    errno = 0;
    assert(!gbm_bo_import(device, GBM_BO_IMPORT_FD, &single, 0) && errno == EINVAL);
    close(gpu_fd); close(gpu_chroma_fd); close(chroma_fd); close(fd);
    close_device(device);
}

/* Mesa: an absent plane has handle .s32 == -1 / stride 0 / offset 0 with
 * errno EINVAL; handle 0 would name "no buffer" to libdrm callers. */
static void plane_accessors(void) {
    struct gbm_device *device = open_device();
    struct gbm_bo *bo = gbm_bo_create(device, 4, 3, GBM_FORMAT_XRGB8888, GBM_BO_USE_WRITE);
    assert(bo);
    assert(gbm_bo_get_handle_for_plane(bo, 0).u32 == gbm_bo_get_handle(bo).u32);
    assert(gbm_bo_get_stride_for_plane(bo, 0) == 16 && gbm_bo_get_offset(bo, 0) == 0);
    const int planes[] = {1, GBM_MAX_PLANES, -1};
    for (unsigned i = 0; i < 3; ++i) {
        errno = 0;
        assert(gbm_bo_get_handle_for_plane(bo, planes[i]).s32 == -1 && errno == EINVAL);
        errno = 0;
        assert(gbm_bo_get_stride_for_plane(bo, planes[i]) == 0 && errno == EINVAL);
        errno = 0;
        assert(gbm_bo_get_offset(bo, planes[i]) == 0 && errno == EINVAL);
        errno = 0;
        assert(gbm_bo_get_fd_for_plane(bo, planes[i]) == -1 && errno == EINVAL);
    }
    gbm_bo_destroy(bo);
    close_device(device);
}

int main(int argc, char **argv) {
    static const struct { const char *name; void (*run)(void); } cases[] = {
        {"user-data-replace", user_data_replace},
        {"import-fd-bounds", import_fd_bounds},
        {"import-fd-modifier", import_fd_modifier},
        {"import-gpu-tier", import_gpu_tier},
        {"import-usage", import_usage},
        {"legacy-formats", legacy_formats},
        {"usage-flags", usage_flags},
        {"plane-accessors", plane_accessors},
        {"rgb565", rgb565},
        {"widened-formats", widened_formats},
        {"import-gpu-format", import_gpu_format},
        {"import-egl-image", import_egl_image},
        {"yuv-buffers", yuv_buffers},
        {"import-yuv", import_yuv},
    };
    if (argc != 2) { fprintf(stderr, "usage: %s <case>\n", argv[0]); return 2; }
    for (unsigned i = 0; i < sizeof cases / sizeof cases[0]; ++i) {
        if (!strcmp(argv[1], cases[i].name)) {
            cases[i].run();
            printf("PASS gbm %s\n", cases[i].name);
            return 0;
        }
    }
    fprintf(stderr, "unknown case %s\n", argv[1]);
    return 2;
}
