/* Observe the real DRM two-call mode enumeration, not a host-side mode list. */
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

struct mode {
    uint32_t clock;
    uint16_t hdisplay, hsync_start, hsync_end, htotal, hskew;
    uint16_t vdisplay, vsync_start, vsync_end, vtotal, vscan;
    uint32_t vrefresh, flags, type;
    char name[32];
};
struct connector {
    uint64_t encoders, modes, props, prop_values;
    uint32_t count_modes, count_props, count_encoders, encoder_id;
    uint32_t id, type, type_id, connection, mm_width, mm_height, subpixel, pad;
};
struct absinfo { int32_t value, minimum, maximum, fuzz, flat, resolution; };
struct dumb { uint32_t height, width, bpp, flags, handle, pitch; uint64_t size; };
struct fb {
    uint32_t id, width, height, format, flags, handles[4], pitches[4], offsets[4];
    uint64_t modifiers[4];
};
struct crtc {
    uint64_t connectors;
    uint32_t count, id, fb, x, y, gamma_size, mode_valid;
    struct mode mode;
};
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "%s: %s\n", #x, strerror(errno)); return 1; } } while (0)
#define GETCONNECTOR 0xc05064a7

int main(int argc, char **argv) {
    int max_x = argc > 1 ? atoi(argv[1]) : 65535;
    int max_y = argc > 2 ? atoi(argv[2]) : 65535;
    int fd = open("/dev/dri/card0", O_RDWR);
    CHECK(fd >= 0);
    struct connector c = { .id = 1 };
    CHECK(ioctl(fd, GETCONNECTOR, &c) == 0);
    CHECK(c.count_modes >= 17 && c.count_modes <= 32);
    struct mode modes[32];
    memset(modes, 0x5a, sizeof modes);
    c.modes = (uintptr_t)modes;
    c.count_modes = 1;
    CHECK(ioctl(fd, GETCONNECTOR, &c) == 0);
    CHECK(modes[0].clock == 0x5a5a5a5a);
    CHECK(ioctl(fd, GETCONNECTOR, &c) == 0);
    CHECK((modes[0].type & (1 << 3)) != 0);
    unsigned preferred = 0, small = 0, fullhd = 0, uhd = 0;
    for (unsigned i = 0; i < c.count_modes; i++) {
        struct mode *m = &modes[i];
        preferred += (m->type & (1 << 3)) != 0;
        small += m->hdisplay == 800 && m->vdisplay == 600;
        fullhd += m->hdisplay == 1920 && m->vdisplay == 1080;
        uhd += m->hdisplay == 3840 && m->vdisplay == 2160;
        for (unsigned j = 0; j < i; j++) {
            CHECK(m->hdisplay != modes[j].hdisplay || m->vdisplay != modes[j].vdisplay);
        }
    }
    CHECK(preferred == 1 && small == 1 && fullhd == 1 && uhd == 1);
    int input = open("/dev/input/event1", O_RDONLY);
    CHECK(input >= 0);
    struct absinfo x, y;
    CHECK(ioctl(input, 0x80184540, &x) == 0 && x.maximum == max_x);
    CHECK(ioctl(input, 0x80184541, &y) == 0 && y.maximum == max_y);
    CHECK(ioctl(fd, 0x641e, 0) == 0);
    for (unsigned width = 800; width <= 1280; width += 480) {
        unsigned height = width == 800 ? 600 : 720;
        struct dumb bo = { .height = height, .width = width, .bpp = 32 };
        CHECK(ioctl(fd, 0xc02064b2, &bo) == 0);
        struct fb fb = { .width = width, .height = height, .format = 0x34325258,
                         .handles = {bo.handle}, .pitches = {bo.pitch} };
        CHECK(ioctl(fd, 0xc06864b8, &fb) == 0);
        struct crtc crtc = { .id = 1, .fb = fb.id, .mode_valid = 1 };
        for (unsigned i = 0; i < c.count_modes; i++) {
            if (modes[i].hdisplay == width && modes[i].vdisplay == height) crtc.mode = modes[i];
        }
        CHECK(crtc.mode.hdisplay == width);
        CHECK(ioctl(fd, 0xc06864a2, &crtc) == 0);
        CHECK(ioctl(input, 0x80184540, &x) == 0 && x.maximum == max_x);
        CHECK(ioctl(input, 0x80184541, &y) == 0 && y.maximum == max_y);
        CHECK(ioctl(fd, 0xc00464af, &fb.id) == 0);
        CHECK(ioctl(fd, 0xc00464b4, &bo.handle) == 0);
    }
    CHECK(close(input) == 0);
    CHECK(close(fd) == 0);
    printf("kms-modes: %u modes, one preferred, 800x600 through 3840x2160: ok\n", c.count_modes);
    puts("kms-modes: cached absolute range survives two modesets: ok");
    return 0;
}
