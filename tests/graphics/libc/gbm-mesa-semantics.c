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

#define MAX_HANDLES 64
static unsigned created;              /* last allocated GEM handle */
static unsigned live[MAX_HANDLES];    /* GEM handle reference: 1 while open */
static unsigned closes[MAX_HANDLES];  /* drmCloseBufferHandle calls per handle */
static int gpu_handle[MAX_HANDLES];   /* MAP_DUMB answers EINVAL (GPU tier) */
static unsigned map_dumb_calls, allocations;
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
        /* The kernel's dumb rule: any nonzero bpp, rows rounded to 4 bytes. */
        d->handle = new_handle(0); d->pitch = ((d->width * d->bpp + 7) / 8 + 3) & ~3u;
        d->size = (uint64_t)d->pitch * d->height;
        return 0;
    }
    if (request == 0xc01064e0u) { errno = ENOSYS; return -1; } /* no shared GL context */
    if (request == DRM_IOCTL_PRIME_FD_TO_HANDLE) {
        struct drm_prime_handle *prime = data;
        for (unsigned i = 0; i < sizeof primes / sizeof primes[0]; ++i) {
            if (primes[i].handle && primes[i].fd == prime->fd) {
                /* PRIME reimport on a file reuses its live GEM name. */
                if (!live[primes[i].handle]) live[primes[i].handle] = 1;
                prime->handle = primes[i].handle;
                return 0;
            }
        }
        errno = EBADF; return -1;
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
    /* Other import types stay honest failures. */
    errno = 0;
    assert(!gbm_bo_import(device, GBM_BO_IMPORT_WL_BUFFER, &base, 0) && errno == EINVAL);
    errno = 0;
    assert(!gbm_bo_import(device, GBM_BO_IMPORT_EGL_IMAGE, &base, 0) && errno == EINVAL);
    close(fd);
    close_device(device);
}

/* An imported GPU-tier BO is marked like a native GPU allocation: it is
 * unmappable, and a CPU-write usage request is refused at import. */
static void import_gpu_tier(void) {
    struct gbm_device *device = open_device();
    uint32_t handle = new_handle(1);
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

/* Unsupported usage bits fail; they are never silently granted. */
static void import_usage(void) {
    struct gbm_device *device = open_device();
    uint32_t handle = new_handle(0);
    int fd = prime_fd(handle, 48);
    struct gbm_import_fd_data data = {.fd = fd, .width = 4, .height = 3, .stride = 16,
        .format = GBM_FORMAT_XRGB8888};
    const uint32_t refused[] = {GBM_BO_USE_PROTECTED, GBM_BO_USE_FRONT_RENDERING,
        GBM_BO_FIXED_COMPRESSION_DEFAULT, 1u << 20};
    for (unsigned i = 0; i < sizeof refused / sizeof refused[0]; ++i) {
        errno = 0;
        assert(!gbm_bo_import(device, GBM_BO_IMPORT_FD, &data,
            GBM_BO_USE_SCANOUT | refused[i]) && errno == EINVAL);
    }
    struct gbm_bo *bo = gbm_bo_import(device, GBM_BO_IMPORT_FD, &data,
        GBM_BO_USE_SCANOUT | GBM_BO_USE_CURSOR | GBM_BO_USE_RENDERING |
        GBM_BO_USE_WRITE | GBM_BO_USE_LINEAR);
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
 * front-buffer rendering, fixed-rate compression, unknown bits). */
static void usage_flags(void) {
    struct gbm_device *device = open_device();
    const uint32_t refused[] = {GBM_BO_USE_PROTECTED, GBM_BO_USE_FRONT_RENDERING,
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

/* RGB565, the 16-bpp format the primary plane scans out, is a CPU-tier
 * (dumb) allocation: scanout, write and linear usages, but no GL render
 * target or cursor, since Kandelo's EGL configs and cursor plane are 32-bpp. */
static void rgb565(void) {
    struct gbm_device *device = open_device();
    assert(gbm_device_is_format_supported(device, GBM_FORMAT_RGB565,
        GBM_BO_USE_SCANOUT | GBM_BO_USE_WRITE | GBM_BO_USE_LINEAR) == 1);
    assert(gbm_device_is_format_supported(device, GBM_FORMAT_RGB565, GBM_BO_USE_RENDERING) == 0);
    assert(gbm_device_is_format_supported(device, GBM_FORMAT_RGB565, GBM_BO_USE_CURSOR) == 0);
    struct gbm_bo *bo = gbm_bo_create(device, 5, 3, GBM_FORMAT_RGB565,
        GBM_BO_USE_SCANOUT | GBM_BO_USE_WRITE);
    assert(bo && gbm_bo_get_bpp(bo) == 16 && gbm_bo_get_stride(bo) == 12);
    assert(gbm_bo_get_format(bo) == GBM_FORMAT_RGB565);
    gbm_bo_destroy(bo);
    errno = 0;
    assert(!gbm_bo_create(device, 5, 3, GBM_FORMAT_RGB565, GBM_BO_USE_RENDERING) && errno == EINVAL);
    errno = 0;
    assert(!gbm_surface_create(device, 5, 3, GBM_FORMAT_RGB565, GBM_BO_USE_SCANOUT | GBM_BO_USE_RENDERING)
        && errno == EINVAL);
    assert(gbm_device_get_format_modifier_plane_count(device, GBM_FORMAT_RGB565, DRM_FORMAT_MOD_LINEAR) == 1);
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
