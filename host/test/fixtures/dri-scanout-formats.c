/* Normal DRM dumb-buffer scanout: exact colors, pitch and format selection. */
#include <libdrm/xf86drm.h>
#include <libdrm/xf86drmMode.h>
#include <drm/drm_fourcc.h>
#include <drm/drm_mode.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

#define CHECK(value) do { if (!(value)) { \
    fprintf(stderr, "FAIL line %d: %s (errno %d)\n", __LINE__, #value, errno); return 1; \
} } while (0)
int main(int argc, char **argv) {
    CHECK(argc == 2);
    uint32_t format = (uint32_t)strtoul(argv[1], NULL, 10);
    CHECK(format == DRM_FORMAT_XRGB8888 || format == DRM_FORMAT_ARGB8888 ||
        format == DRM_FORMAT_XBGR8888 || format == DRM_FORMAT_ABGR8888 || format == DRM_FORMAT_RGB565);
    int fd = open("/dev/dri/card0", O_RDWR | O_CLOEXEC);
    CHECK(fd >= 0);
    drmModeRes *resources = drmModeGetResources(fd);
    CHECK(resources && resources->count_crtcs > 0 && resources->count_connectors > 0);
    drmModeConnector *connector = drmModeGetConnector(fd, resources->connectors[0]);
    CHECK(connector && connector->count_modes > 0);
    drmModeModeInfo mode = connector->modes[0];
    uint32_t connector_id = connector->connector_id, crtc_id = resources->crtcs[0];
    drmModeFreeConnector(connector); drmModeFreeResources(resources);
    struct drm_mode_create_dumb dumb = {.width = mode.hdisplay, .height = mode.vdisplay, .bpp = 32};
    CHECK(ioctl(fd, DRM_IOCTL_MODE_CREATE_DUMB, &dumb) == 0);
    /* Malformed views must fail before publishing any FB or reaching the
     * display. RGB565 intentionally has extra valid row padding below. */
    for (unsigned bad = 0; bad < 4; bad++) {
        uint32_t handles[4] = {dumb.handle}, pitches[4] = {dumb.pitch}, offsets[4] = {0};
        uint32_t width = dumb.width, height = dumb.height, untouched = 0xa55abeef;
        if (bad == 0) width = dumb.pitch / (format == DRM_FORMAT_RGB565 ? 2 : 4) + 1;
        if (bad == 1) height++;
        if (bad == 2) offsets[0] = (uint32_t)dumb.size;
        if (bad == 3) offsets[0] = UINT32_MAX;
        errno = 0;
        CHECK(drmModeAddFB2(fd, width, height, format, handles, pitches, offsets, &untouched, 0) < 0);
        CHECK(errno == EINVAL && untouched == 0xa55abeef);
    }
    struct drm_mode_map_dumb mapping = {.handle = dumb.handle};
    CHECK(ioctl(fd, DRM_IOCTL_MODE_MAP_DUMB, &mapping) == 0);
    uint8_t *pixels = mmap(NULL, dumb.size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, mapping.offset);
    CHECK(pixels != MAP_FAILED);
    /* RGB565 has deliberately padded rows in this 32-bpp allocation. */
    memset(pixels, 0x5a, dumb.size);
    for (uint32_t y = 0; y < dumb.height; y++) {
        for (uint32_t x = 0; x < dumb.width; x++) {
            unsigned quadrant = (y >= dumb.height / 2 ? 2 : 0) + (x >= dumb.width / 2 ? 1 : 0);
            uint32_t r = quadrant == 0 || quadrant == 3 ? 255 : 0;
            uint32_t g = quadrant == 1 || quadrant == 3 ? 255 : 0;
            uint32_t b = quadrant == 2 || quadrant == 3 ? 255 : 0;
            if (format == DRM_FORMAT_RGB565) {
                ((uint16_t *)(pixels + y * dumb.pitch))[x] = (r >> 3) << 11 | (g >> 2) << 5 | b >> 3;
            } else {
                int rgb_order = format == DRM_FORMAT_XBGR8888 || format == DRM_FORMAT_ABGR8888;
                uint32_t word = rgb_order ? r | g << 8 | b << 16 : b | g << 8 | r << 16;
                ((uint32_t *)(pixels + y * dumb.pitch))[x] = word | 0x40000000;
            }
        }
    }
    uint32_t handles[4] = {dumb.handle}, pitches[4] = {dumb.pitch}, offsets[4] = {0}, fb = 0;
    CHECK(drmModeAddFB2(fd, dumb.width, dumb.height, format, handles, pitches, offsets, &fb, 0) == 0);
    CHECK(drmModeSetCrtc(fd, crtc_id, fb, 0, 0, &connector_id, 1, &mode) == 0);
    puts("scanout colors ready"); fflush(stdout);
    char command;
    CHECK(read(STDIN_FILENO, &command, 1) == 1 && command == 'g');
    /* A single live scanout write without another SETCRTC/PAGE_FLIP must
     * become visible too; a sparse content hash can miss this location. */
    if (format == DRM_FORMAT_RGB565) ((uint16_t *)(pixels + 19 * dumb.pitch))[17] = 0xffff;
    else ((uint32_t *)(pixels + 19 * dumb.pitch))[17] = 0x40ffffff;
    puts("unflipped pixel updated"); fflush(stdout);
    CHECK(read(STDIN_FILENO, &command, 1) == 1 && command == 'q');
    CHECK(drmModeSetCrtc(fd, crtc_id, 0, 0, 0, NULL, 0, NULL) == 0);
    CHECK(drmModeRmFB(fd, fb) == 0 && munmap(pixels, dumb.size) == 0);
    struct drm_mode_destroy_dumb destroy = {.handle = dumb.handle};
    CHECK(ioctl(fd, DRM_IOCTL_MODE_DESTROY_DUMB, &destroy) == 0 && close(fd) == 0);
    puts("scanout colors retired");
    return 0;
}
