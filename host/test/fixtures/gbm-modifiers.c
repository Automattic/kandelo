/* Public GBM requests through the normal SDK and real DRM ioctl path. */
#include <gbm.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define CHECK(x) do { if (!(x)) { fprintf(stderr, "line %d: %s errno=%d\n", __LINE__, #x, errno); return 1; } } while (0)
#define LINEAR UINT64_C(0)
#define UNAVAILABLE UINT64_C(0x0100000000000001)

int main(void) {
    int fd = open("/dev/dri/card0", O_RDWR | O_CLOEXEC);
    CHECK(fd >= 0);
    struct gbm_device *device = gbm_create_device(fd);
    CHECK(device);
    uint32_t usage = GBM_BO_USE_SCANOUT | GBM_BO_USE_RENDERING;
    const uint64_t linear[] = {LINEAR}, unavailable[] = {UNAVAILABLE};
    const uint64_t choices[] = {UNAVAILABLE, LINEAR};
    const struct { const uint64_t *list; unsigned count; uint32_t flags; } invalid[] = {
        {NULL, 1, usage}, {linear, 0, usage}, {unavailable, 1, usage},
        {linear, 1, usage | GBM_BO_USE_LINEAR},
    };
    for (unsigned i = 0; i < sizeof(invalid) / sizeof(invalid[0]); ++i) {
        errno = 0;
        CHECK(!gbm_bo_create_with_modifiers2(device, 16, 8, GBM_FORMAT_ABGR8888,
            invalid[i].list, invalid[i].count, invalid[i].flags) && errno == EINVAL);
        errno = 0;
        CHECK(!gbm_surface_create_with_modifiers2(device, 16, 8, GBM_FORMAT_ABGR8888,
            invalid[i].list, invalid[i].count, invalid[i].flags) && errno == EINVAL);
    }
    errno = 0;
    CHECK(!gbm_surface_create_with_modifiers(device, 16, 8, GBM_FORMAT_ABGR8888,
        unavailable, 1) && errno == EINVAL);
    struct gbm_surface *surface = gbm_surface_create_with_modifiers(device, 16, 8,
        GBM_FORMAT_ABGR8888, choices, 2);
    CHECK(surface);
    gbm_surface_destroy(surface);
    struct gbm_bo *bo = gbm_bo_create_with_modifiers2(device, 16, 8, GBM_FORMAT_ABGR8888,
        choices, 2, usage);
    CHECK(bo && gbm_bo_get_modifier(bo) == LINEAR && gbm_bo_get_plane_count(bo) == 1);
    gbm_bo_destroy(bo);
    bo = gbm_bo_create_with_modifiers2(device, 16, 8, GBM_FORMAT_ABGR8888,
        NULL, 0, usage | GBM_BO_USE_LINEAR);
    CHECK(bo && gbm_bo_get_modifier(bo) == LINEAR);
    gbm_bo_destroy(bo);
    const uint32_t formats[] = {GBM_FORMAT_XRGB8888, GBM_FORMAT_ARGB8888,
        GBM_FORMAT_XBGR8888, GBM_FORMAT_ABGR8888};
    for (unsigned i = 0; i < 4; ++i) {
        CHECK(gbm_device_get_format_modifier_plane_count(device, formats[i], LINEAR) == 1);
        CHECK(gbm_device_get_format_modifier_plane_count(device, formats[i], UNAVAILABLE) == -1);
    }
    CHECK(gbm_device_get_format_modifier_plane_count(device, 0xdeadbeef, LINEAR) == -1);
    struct { struct gbm_format_name_desc desc; char sentinel; } name = {.sentinel = 'Q'};
    CHECK(gbm_format_get_name(GBM_BO_FORMAT_XRGB8888, &name.desc) == name.desc.name);
    CHECK(!strcmp(name.desc.name, "XR24"));
    CHECK(gbm_format_get_name(GBM_BO_FORMAT_ARGB8888, &name.desc) == name.desc.name);
    CHECK(!strcmp(name.desc.name, "AR24") && name.sentinel == 'Q');
    gbm_device_destroy(device);
    CHECK(close(fd) == 0);
    puts("OK GBM modifier admission and public format queries");
    return 0;
}
