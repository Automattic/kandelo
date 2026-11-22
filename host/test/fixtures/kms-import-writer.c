#include <libdrm/xf86drm.h>
#include <libdrm/xf86drmMode.h>
#include <drm/drm_fourcc.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

struct dumb { uint32_t height, width, bpp, flags, handle, pitch; uint64_t size; };
struct prime { uint32_t handle, flags; int32_t fd; };
struct mapping { uint32_t handle, pad; uint64_t offset; };
struct cursor { uint32_t flags, crtc; int32_t x, y; uint32_t width, height, handle; int32_t hot_x, hot_y; };
#define CHECK(x) do { if (!(x)) { perror(#x); exit(1); } } while (0)

static uint32_t *map_bo(int fd, uint32_t handle) {
    struct mapping map = {.handle = handle};
    if (ioctl(fd, 0xc01064b3, &map) != 0) return MAP_FAILED;
    return mmap(NULL, 16384, PROT_READ | PROT_WRITE, MAP_SHARED, fd, map.offset);
}

/* A retained cursor is invisible on a dark CRTC. Enable a real primary
 * scanout before observing the independent imported cursor plane. */
static uint32_t enable_primary(int fd) {
    drmModeRes *resources = drmModeGetResources(fd);
    CHECK(resources && resources->count_crtcs && resources->count_connectors);
    uint32_t crtc = resources->crtcs[0];
    drmModeConnector *connector = drmModeGetConnector(fd, resources->connectors[0]);
    CHECK(connector && connector->connection == DRM_MODE_CONNECTED && connector->count_modes);
    drmModeModeInfo mode = connector->modes[0];
    uint32_t connector_id = connector->connector_id;
    struct dumb background = {.width = mode.hdisplay, .height = mode.vdisplay, .bpp = 32};
    CHECK(ioctl(fd, 0xc02064b2, &background) == 0);
    struct mapping map = {.handle = background.handle};
    CHECK(ioctl(fd, 0xc01064b3, &map) == 0);
    void *bytes = mmap(NULL, background.size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, map.offset);
    CHECK(bytes != MAP_FAILED);
    memset(bytes, 0, background.size);
    CHECK(munmap(bytes, background.size) == 0);
    uint32_t handles[4] = {background.handle}, pitches[4] = {background.pitch}, offsets[4] = {0}, framebuffer;
    CHECK(drmModeAddFB2(fd, background.width, background.height, DRM_FORMAT_XRGB8888,
        handles, pitches, offsets, &framebuffer, 0) == 0);
    CHECK(drmModeSetCrtc(fd, crtc, framebuffer, 0, 0, &connector_id, 1, &mode) == 0);
    CHECK(drmCloseBufferHandle(fd, background.handle) == 0);
    drmModeFreeConnector(connector);
    drmModeFreeResources(resources);
    return crtc;
}

int main(int argc, char **argv) {
    int late_update = argc > 1 && strcmp(argv[1], "importer-after-submit") == 0;
    int importer_writes = argc > 1 && (strcmp(argv[1], "importer") == 0 || late_update);
    int allocator_writes_late = argc > 1 && strcmp(argv[1], "allocator-after-import") == 0;
    int gate[2], ready[2], updated[2];
    CHECK(pipe(gate) == 0 && pipe(ready) == 0 && pipe(updated) == 0);
    int fd = open("/dev/dri/card0", O_RDWR);
    CHECK(fd >= 0);
    struct dumb bo = {.width = 64, .height = 64, .bpp = 32};
    CHECK(ioctl(fd, 0xc02064b2, &bo) == 0);
    uint32_t *pixels = map_bo(fd, bo.handle);
    CHECK(pixels != MAP_FAILED);
    for (int i = 0; i < 4096; i++) pixels[i] = (importer_writes || allocator_writes_late) ? 0 : 0xffff0000;
    struct prime shared = {.handle = bo.handle, .flags = 2 /* DRM_RDWR */};
    CHECK(ioctl(fd, 0xc00c642d, &shared) == 0);
    /* This producer keeps its storage, while an independent DRM file in
     * the consumer must acquire its own master grant. */
    CHECK(ioctl(fd, 0x641f, 0) == 0);
    pid_t child = fork();
    CHECK(child >= 0);
    if (child == 0) {
        CHECK(close(fd) == 0);
        int card = open("/dev/dri/card0", O_RDWR);
        CHECK(card >= 0);
        struct prime imported = {.fd = shared.fd};
        CHECK(ioctl(card, 0xc00c642e, &imported) == 0);
        uint32_t *image = map_bo(card, imported.handle);
        CHECK(image != MAP_FAILED);
        if (allocator_writes_late) {
            /* This peer starts with the old pixels and never writes them. */
            CHECK(image[0] == 0);
            CHECK(write(ready[1], "r", 1) == 1);
            char byte;
            CHECK(read(updated[0], &byte, 1) == 1);
        }
        if (importer_writes) for (int i = 0; i < 4096; i++) image[i] = 0xffff0000;
        CHECK(ioctl(card, 0x641e, 0) == 0);
        uint32_t crtc = enable_primary(card);
        struct cursor cursor = {.flags = 3, .crtc = crtc, .width = 64, .height = 64,
                                .handle = imported.handle, .x = 30, .y = 40};
        CHECK(ioctl(card, 0xc02464bb, &cursor) == 0);
        printf("cursor submitted by %s\n", argv[1]);
        fflush(stdout);
        if (late_update) {
            char byte;
            CHECK(read(STDIN_FILENO, &byte, 1) == 1);
            for (int i = 0; i < 4096; i++) image[i] = 0xff00ff00;
            puts("cursor updated without resubmission");
            fflush(stdout);
        }
    }
    if (child != 0 && allocator_writes_late) {
        char byte;
        CHECK(read(ready[0], &byte, 1) == 1);
        for (int i = 0; i < 4096; i++) pixels[i] = 0xffff0000;
        CHECK(write(updated[1], "u", 1) == 1);
    }
    char byte;
    CHECK(read(gate[0], &byte, 1) == 1);
    return 0;
}
