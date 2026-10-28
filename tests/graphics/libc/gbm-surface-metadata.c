/* Actual GBM source with a DRM allocation double: this tests the native
 * window registry, not kernel allocation or pixel rendering. */
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
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

int _wpk_gbm_surface_metadata(const void *, uint32_t *, uint32_t *, uint32_t *, uint32_t *);
int _wpk_gbm_surface_dimensions(const void *, uint32_t *, uint32_t *);
int _wpk_gbm_device_metadata(const void *, int *, uint64_t *);
static int device_fd;
static unsigned created, closed, fail_allocation;
static uint32_t imported_handle;
static int fail_unmap, gpu_enabled;
static unsigned unmap_attempts;
static void same_device_file(int fd) {
    struct stat expected, actual;
    assert(fstat(device_fd, &expected) == 0 && fstat(fd, &actual) == 0);
    assert(expected.st_dev == actual.st_dev && expected.st_ino == actual.st_ino);
}
int graphics_gbm_munmap(void *address, size_t length) {
    unmap_attempts++;
    if (fail_unmap) { fail_unmap = 0; errno = EINTR; return -1; }
    return munmap(address, length);
}
int drmIoctl(int fd, unsigned long request, void *data) {
    same_device_file(fd);
    if (request == 0xc01064e0u && gpu_enabled) {
        uint32_t *words = data;
        if (fail_allocation && created+1 == fail_allocation) { errno = ENOMEM; return -1; }
        uint32_t pitch = words[0]*4;
        words[2] = ++created; words[3] = pitch;
        return 0;
    }
    if (request == DRM_IOCTL_PRIME_HANDLE_TO_FD) {
        struct drm_prime_handle *prime = data;
        assert(prime->handle && prime->handle <= created);
        prime->fd = fcntl(fd, F_DUPFD_CLOEXEC, 0);
        return prime->fd < 0 ? -1 : 0;
    }
    if (request == DRM_IOCTL_MODE_CREATE_DUMB) {
        if (fail_allocation && created+1 == fail_allocation) { errno = ENOMEM; return -1; }
        struct drm_mode_create_dumb *d = data;
        d->handle = ++created; d->pitch = d->width*4; d->size = (uint64_t)d->pitch*d->height;
        return 0;
    }
    if (request == DRM_IOCTL_PRIME_FD_TO_HANDLE && imported_handle) {
        struct drm_prime_handle *prime = data;
        assert(prime->fd == 42);
        prime->handle = imported_handle;
        return 0;
    }
    if (request == DRM_IOCTL_MODE_MAP_DUMB) {
        struct drm_mode_map_dumb *d = data;
        d->offset = (uint64_t)d->handle * (uint64_t)sysconf(_SC_PAGESIZE);
        return 0;
    }
    errno = ENOSYS; return -1;
}
int drmCloseBufferHandle(int fd, uint32_t handle) {
    same_device_file(fd);
    assert(handle && handle <= created); closed++; return 0;
}
static void retained_device_file(void) {
    int input = dup(device_fd); assert(input >= 0);
    struct gbm_device *device = gbm_create_device(input); assert(device);
    assert(gbm_device_get_fd(device) == input);
    struct gbm_bo *bo = gbm_bo_create(device, 4, 3, GBM_FORMAT_ABGR8888, GBM_BO_USE_WRITE);
    assert(bo);
    gbm_device_destroy(device);
    assert(close(input) == 0);
    int prime = gbm_bo_get_fd(bo); assert(prime >= 0);
    assert(close(prime) == 0);
    gbm_bo_destroy(bo);
}
static unsigned ring_callbacks;
static struct gbm_surface *retired_ring;
static void ring_callback(struct gbm_bo *bo, void *data) {
    assert(bo && data == &ring_callbacks);
    assert(!gbm_surface_has_free_buffers(retired_ring));
    ++ring_callbacks;
}
static void rendered_ring_ownership(void) {
    int input = dup(device_fd); assert(input >= 0);
    struct gbm_device *device = gbm_create_device(input); assert(device);
    struct gbm_surface *window = gbm_surface_create(device, 4, 3,
        GBM_FORMAT_ABGR8888, GBM_BO_USE_RENDERING | GBM_BO_USE_SCANOUT);
    assert(window && gbm_surface_has_free_buffers(window) == 1);
    assert(!gbm_surface_lock_front_buffer(window));
    struct wpk_gbm_frame initial = {0}, candidate = {0}; void *lease = NULL;
    /* A missing GPU backend must not substitute a CPU BO for the target. */
    assert(!_wpk_gbm_window_acquire(window, &lease, &initial) && !lease && !initial.handle);
    gpu_enabled = 1;
    assert(_wpk_gbm_window_acquire(window, &lease, &initial) && lease);
    void *other = NULL;
    assert(!_wpk_gbm_window_acquire(window, &other, &candidate) && !other);
    gbm_device_destroy(device); assert(close(input) == 0);
    /* Lazy allocation must use the surface's owned device after withdrawal. */
    fail_allocation = created+1;
    assert(!_wpk_gbm_window_prepare(lease, &candidate));
    assert(!gbm_surface_lock_front_buffer(window));
    fail_allocation = 0;
    assert(_wpk_gbm_window_prepare(lease, &candidate));
    uint32_t next = candidate.handle;
    _wpk_gbm_window_finish(lease, 0);
    assert(!gbm_surface_lock_front_buffer(window));
    assert(_wpk_gbm_window_prepare(lease, &candidate) && candidate.handle == next);
    _wpk_gbm_window_finish(lease, 1);
    struct gbm_bo *front[3];
    front[0] = gbm_surface_lock_front_buffer(window);
    assert(front[0] && gbm_bo_get_handle(front[0]).u32 == initial.handle);
    assert(!gbm_surface_lock_front_buffer(window));
    for (unsigned i = 1; i < 3; ++i) {
        assert(_wpk_gbm_window_prepare(lease, &candidate));
        _wpk_gbm_window_finish(lease, 1);
        front[i] = gbm_surface_lock_front_buffer(window);
        assert(front[i] && front[i] != front[i-1] && front[i] != front[0]);
    }
    assert(!gbm_surface_has_free_buffers(window));
    assert(!_wpk_gbm_window_prepare(lease, &candidate) && errno == EBUSY);
    for (unsigned i = 0; i < 3; ++i)
        gbm_bo_set_user_data(front[i], &ring_callbacks, ring_callback);
    retired_ring = window;
    gbm_surface_destroy(window);
    assert(!gbm_surface_lock_front_buffer(window));
    _wpk_gbm_window_release(lease);
    assert(!ring_callbacks && fcntl(initial.fd,F_GETFD) >= 0);
    gbm_surface_release_buffer(window, front[0]);
    gbm_surface_release_buffer(window, front[0]);
    gbm_surface_release_buffer(window, (void *)(uintptr_t)1);
    gbm_surface_release_buffer(window, front[1]);
    assert(!ring_callbacks);
    gbm_surface_release_buffer(window, front[2]);
    assert(ring_callbacks == 3 && fcntl(initial.fd,F_GETFD) == -1 && errno == EBADF);
    gpu_enabled = 0;
    assert(created == closed);
}
static void rejected(const void *pointer) {
    uint32_t width=101,height=102,format=103,flags=104;
    assert(!_wpk_gbm_surface_metadata(pointer,&width,&height,&format,&flags));
    assert(width == 101 && height == 102 && format == 103 && flags == 104);
    assert(!_wpk_gbm_surface_dimensions(pointer,&width,&height));
    assert(width == 101 && height == 102);
}
static void imported_handle_lifetime(struct gbm_device *device) {
    unsigned before = closed;
    struct gbm_bo *source = gbm_bo_create(device, 4, 3, GBM_FORMAT_ABGR8888, GBM_BO_USE_WRITE);
    assert(source);
    imported_handle = gbm_bo_get_handle(source).u32;
    struct gbm_import_fd_data data = {.fd = 42, .width = 4, .height = 3,
        .stride = gbm_bo_get_stride(source), .format = GBM_FORMAT_ABGR8888};
    struct gbm_bo *first = gbm_bo_import(device, GBM_BO_IMPORT_FD, &data, 0);
    struct gbm_bo *second = gbm_bo_import(device, GBM_BO_IMPORT_FD, &data, 0);
    assert(first && second);
    gbm_bo_destroy(first); assert(closed == before);
    gbm_bo_destroy(source); assert(closed == before);
    gbm_bo_destroy(second); assert(closed == before + 1);
    imported_handle = 0;
}
static void public_format_queries(struct gbm_device *device) {
    unsigned before = created;
    const uint32_t formats[] = {GBM_FORMAT_XRGB8888, GBM_FORMAT_ARGB8888,
        GBM_FORMAT_XBGR8888, GBM_FORMAT_ABGR8888};
    for (unsigned i = 0; i < 4; ++i) {
        assert(gbm_device_get_format_modifier_plane_count(device, formats[i], DRM_FORMAT_MOD_LINEAR) == 1);
        assert(gbm_device_get_format_modifier_plane_count(device, formats[i], UINT64_C(0x0100000000000001)) == -1);
    }
    assert(gbm_device_get_format_modifier_plane_count(device, 0xdeadbeef, DRM_FORMAT_MOD_LINEAR) == -1);
    assert(gbm_device_get_format_modifier_plane_count(device, GBM_BO_FORMAT_XRGB8888, DRM_FORMAT_MOD_LINEAR) == 1);
    assert(gbm_device_get_format_modifier_plane_count(device, GBM_BO_FORMAT_ARGB8888, DRM_FORMAT_MOD_LINEAR) == 1);
    struct { struct gbm_format_name_desc desc; char sentinel; } name = {.sentinel = 'Q'};
    assert(gbm_format_get_name(GBM_BO_FORMAT_XRGB8888, &name.desc) == name.desc.name);
    assert(!strcmp(name.desc.name, "XR24"));
    assert(gbm_format_get_name(GBM_BO_FORMAT_ARGB8888, &name.desc) == name.desc.name);
    assert(!strcmp(name.desc.name, "AR24"));
    assert(gbm_format_get_name(GBM_FORMAT_ABGR8888, &name.desc) == name.desc.name);
    assert(!strcmp(name.desc.name, "AB24"));
    assert(name.sentinel == 'Q' && created == before);
}
static void cpu_mapping(void) {
    int previous_fd = device_fd;
    FILE *file = tmpfile(); assert(file);
    device_fd = fileno(file);
    assert(!ftruncate(device_fd, 1024 * 1024));
    struct gbm_device *device = gbm_create_device(device_fd); assert(device);
    struct gbm_bo *bo = gbm_bo_create(device, 4, 3, GBM_FORMAT_ABGR8888, GBM_BO_USE_WRITE);
    struct gbm_bo *other = gbm_bo_create(device, 4, 3, GBM_FORMAT_ABGR8888, GBM_BO_USE_WRITE);
    assert(bo && other);
    uint32_t pitch = 0;
    void *region_token = NULL, *whole_token = NULL;
    uint8_t *region = gbm_bo_map(bo, 1, 1, 2, 1, GBM_BO_TRANSFER_READ_WRITE, &pitch, &region_token);
    assert(region && pitch == 16 && region_token);
    uint8_t *whole = gbm_bo_map(bo, 0, 0, 4, 3, GBM_BO_TRANSFER_READ_WRITE, &pitch, &whole_token);
    assert(whole && whole_token && region == whole + pitch + 4);
    assert(region_token != whole_token);
    uint32_t color = 0xff123456;
    memcpy(region, &color, 4);
    assert(!memcmp(whole + pitch + 4, &color, 4));
    gbm_bo_unmap(bo, region_token);
    assert(!memcmp(whole + pitch + 4, &color, 4));
    gbm_bo_unmap(other, whole_token);
    assert(!memcmp(whole + pitch + 4, &color, 4));
    gbm_bo_unmap(bo, region_token);
    assert(!memcmp(whole + pitch + 4, &color, 4));
    const struct { uint32_t x, y, w, h, flags; } invalid[] = {
        {0, 0, 0, 1, 0}, {0, 0, 1, 0, 0}, {3, 0, 2, 1, 0},
        {0, 2, 1, 2, 0}, {UINT32_MAX, 0, 2, 1, 0}, {0, UINT32_MAX, 1, 2, 0},
        {0, 0, 1, 1, 0x80000000u},
    };
    for (unsigned i = 0; i < sizeof(invalid) / sizeof(invalid[0]); ++i) {
        uint32_t untouched_pitch = 101; void *untouched_token = (void *)(uintptr_t)102;
        errno = 0;
        assert(!gbm_bo_map(bo, invalid[i].x, invalid[i].y, invalid[i].w, invalid[i].h,
            invalid[i].flags, &untouched_pitch, &untouched_token) && errno == EINVAL);
        assert(untouched_pitch == 101 && untouched_token == (void *)(uintptr_t)102);
    }
    uint32_t unchanged = 101; void *unchanged_token = (void *)(uintptr_t)102;
    assert(!gbm_bo_map(bo, 0, 0, 1, 1, 0, NULL, &unchanged_token));
    assert(unchanged_token == (void *)(uintptr_t)102);
    assert(!gbm_bo_map(bo, 0, 0, 1, 1, 0, &unchanged, NULL) && unchanged == 101);
    fail_unmap = 1; errno = 0;
    gbm_bo_unmap(bo, whole_token);
    assert(errno == EINTR && !memcmp(whole + pitch + 4, &color, 4));
    gbm_bo_unmap(bo, whole_token);
    uint32_t backing = 0;
    off_t offset = (off_t)gbm_bo_get_handle(bo).u32 * sysconf(_SC_PAGESIZE) + pitch + 4;
    assert(pread(device_fd, &backing, 4, offset) == 4 && backing == color);
    void *new_token = NULL;
    whole = gbm_bo_map(bo, 0, 0, 4, 3, 0, &pitch, &new_token);
    assert(whole && new_token && new_token != region_token && new_token != whole_token);
    gbm_bo_unmap(bo, whole_token);
    assert(!memcmp(whole + pitch + 4, &color, 4));
    uint32_t replacement = 0xffabcdef;
    assert(gbm_bo_write(bo, &replacement, 4) == 0);
    assert(!memcmp(whole, &replacement, 4));
    gbm_bo_unmap(bo, new_token);
    assert(gbm_bo_write(bo, &color, 4) == 0);
    assert(pread(device_fd, &backing, 4, offset - pitch - 4) == 4 && backing == color);
    unsigned attempts = unmap_attempts;
    fail_unmap = 1; errno = 0;
    assert(gbm_bo_write(bo, &replacement, 4) == -1 && errno == EINTR);
    assert(unmap_attempts == attempts + 1);
    whole = gbm_bo_map(bo, 0, 0, 4, 3, 0, &pitch, &new_token);
    assert(whole && !memcmp(whole, &replacement, 4));
    gbm_bo_unmap(bo, new_token);
    assert(unmap_attempts == attempts + 2);
    gbm_bo_destroy(bo); gbm_bo_destroy(other); gbm_device_destroy(device);
    assert(!fclose(file)); device_fd = previous_fd;
}
static void modifier_requests(struct gbm_device *device) {
    const uint64_t linear[] = {DRM_FORMAT_MOD_LINEAR};
    const uint64_t unavailable[] = {UINT64_C(0x0100000000000001)};
    const uint64_t choices[] = {unavailable[0], DRM_FORMAT_MOD_LINEAR};
    const uint32_t flags = GBM_BO_USE_SCANOUT | GBM_BO_USE_RENDERING;
    unsigned before = created;
    const struct { const uint64_t *list; unsigned count; uint32_t usage; } invalid[] = {
        {NULL, 1, flags},
        {linear, 0, flags},
        {unavailable, 1, flags},
        {linear, 1, flags | GBM_BO_USE_LINEAR},
    };
    /* Reject malformed/unsatisfiable requests before allocating any BO. */
    for (unsigned kind = 0; kind < 2; ++kind) {
        for (unsigned i = 0; i < sizeof(invalid) / sizeof(invalid[0]); ++i) {
            errno = 0;
            if (kind == 0) {
                struct gbm_bo *bo = gbm_bo_create_with_modifiers2(device, 3, 2,
                    GBM_FORMAT_ABGR8888, invalid[i].list, invalid[i].count, invalid[i].usage);
                assert(!bo && errno == EINVAL);
            } else {
                struct gbm_surface *surface = gbm_surface_create_with_modifiers2(device, 3, 2,
                    GBM_FORMAT_ABGR8888, invalid[i].list, invalid[i].count, invalid[i].usage);
                assert(!surface && errno == EINVAL);
            }
            assert(created == before);
        }
    }
    errno = 0;
    assert(!gbm_surface_create_with_modifiers(device, 3, 2, GBM_FORMAT_ABGR8888,
        unavailable, 1) && errno == EINVAL);
    assert(created == before);
    struct gbm_surface *surface = gbm_surface_create_with_modifiers2(device, 3, 2,
        GBM_FORMAT_ABGR8888, choices, 2, flags);
    assert(surface);
    uint32_t width, height, format, usage;
    assert(_wpk_gbm_surface_metadata(surface, &width, &height, &format, &usage));
    assert(width == 3 && height == 2 && format == GBM_FORMAT_ABGR8888 && usage == flags);
    gbm_surface_destroy(surface);
    struct gbm_bo *bo = gbm_bo_create_with_modifiers2(device, 3, 2, GBM_FORMAT_ABGR8888,
        choices, 2, flags);
    assert(bo && gbm_bo_get_modifier(bo) == DRM_FORMAT_MOD_LINEAR);
    gbm_bo_destroy(bo);
    bo = gbm_bo_create_with_modifiers2(device, 3, 2, GBM_FORMAT_ABGR8888,
        NULL, 0, flags | GBM_BO_USE_LINEAR);
    assert(bo && gbm_bo_get_modifier(bo) == DRM_FORMAT_MOD_LINEAR);
    gbm_bo_destroy(bo);
    assert(created == before + 4 && closed == created);
}
int main(void) {
    device_fd = open("/dev/null", O_RDWR); assert(device_fd >= 0);
    assert(!gbm_create_device(-1) && errno == EBADF);
    struct gbm_device *device = gbm_create_device(device_fd); assert(device);
    int native_fd = -9; uint64_t identity = 0;
    assert(_wpk_gbm_device_metadata(device, &native_fd, &identity));
    same_device_file(native_fd); assert(identity);
    uint64_t first_identity = identity;
    assert(!_wpk_gbm_device_metadata((void *)(uintptr_t)1, &native_fd, &identity));
    same_device_file(native_fd); assert(identity == first_identity);
    rejected(NULL); rejected((void *)(uintptr_t)1); rejected(device);
    size_t page = (size_t)sysconf(_SC_PAGESIZE);
    void *guard = mmap(NULL,page,PROT_NONE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0); assert(guard != MAP_FAILED);
    rejected(guard);
    assert(!_wpk_gbm_device_metadata(guard, &native_fd, &identity));
    same_device_file(native_fd); assert(identity == first_identity);
    assert(!munmap(guard,page));
    struct gbm_surface *first = gbm_surface_create(device,32,24,GBM_FORMAT_ABGR8888,GBM_BO_USE_RENDERING);
    struct gbm_surface *second = gbm_surface_create(device,17,9,GBM_FORMAT_XRGB8888,GBM_BO_USE_SCANOUT);
    assert(first && second);
    uint32_t width=0,height=0,format=0,flags=0;
    assert(_wpk_gbm_surface_metadata(first,&width,&height,&format,&flags));
    assert(width == 32 && height == 24 && format == GBM_FORMAT_ABGR8888 && flags == GBM_BO_USE_RENDERING);
    assert(_wpk_gbm_surface_metadata(second,&width,&height,&format,&flags));
    assert(width == 17 && height == 9 && format == GBM_FORMAT_XRGB8888 && flags == GBM_BO_USE_SCANOUT);
    assert(_wpk_gbm_surface_dimensions(first,&width,&height) && width == 32 && height == 24);
    uintptr_t retired = (uintptr_t)first;
    gbm_surface_destroy(first); rejected((void *)retired);
    assert(_wpk_gbm_surface_metadata(second,&width,&height,&format,&flags) && width == 17);
    gbm_surface_destroy(second); rejected((void *)retired);
    assert(created == 4 && closed == 4);
    fail_allocation = created+2;
    assert(!gbm_surface_create(device,3,2,GBM_FORMAT_ABGR8888,GBM_BO_USE_SCANOUT));
    assert(created == 5 && closed == 5 && errno == ENOMEM);
    rejected((void *)retired);
    fail_allocation = 0;
    modifier_requests(device);
    public_format_queries(device);
    imported_handle_lifetime(device);
    cpu_mapping();
    retained_device_file();
    rendered_ring_ownership();
    uintptr_t retired_device = (uintptr_t)device;
    gbm_device_destroy(device);
    assert(!_wpk_gbm_device_metadata((void *)retired_device, &native_fd, &identity));
    assert(fcntl(device_fd, F_GETFD) >= 0); /* The caller still owns its fd. */
    device = gbm_create_device(device_fd); assert(device);
    assert(_wpk_gbm_device_metadata(device, &native_fd, &identity));
    same_device_file(native_fd); assert(identity != first_identity);
    gbm_device_destroy(device);
    assert(!close(device_fd));
    puts("PASS actual GBM metadata, modifiers, formats and retained CPU mappings");
}
