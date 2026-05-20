/*
 * fbseat-probe - exercise Kandelo's generic graphical seat devices.
 *
 * This is intentionally a userspace probe. It validates the broad Linux-style
 * devices that a lightweight X/Wayland-style desktop stack can build on:
 * /dev/fb0, /dev/input/event0, /dev/input/event1, and /dev/input/mice.
 */
#include <errno.h>
#include <fcntl.h>
#include <linux/fb.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

#define IOC_READ 2u
#define EV_SYN 0x00u
#define EV_KEY 0x01u
#define EV_REL 0x02u
#define REL_X 0x00u
#define REL_Y 0x01u
#define REL_WHEEL 0x08u
#define BTN_LEFT 0x110u
#define BTN_RIGHT 0x111u
#define BTN_MIDDLE 0x112u
#define KEY_A 30u
#define KEY_SPACE 57u
#define KEY_UP 103u
#define EVIOCGVERSION 0x80044501u
#define EVIOCGID 0x80084502u
#define EVIOCGNAME(len) ((IOC_READ << 30) | ((unsigned)(len) << 16) | ('E' << 8) | 0x06u)
#define EVIOCGBIT(ev, len) ((IOC_READ << 30) | ((unsigned)(len) << 16) | ('E' << 8) | (0x20u + (ev)))
#define KDSETMODE 0x4B3A
#define KDGETMODE 0x4B3B
#define KD_TEXT 0
#define KD_GRAPHICS 1
#define VT_OPENQRY 0x5600
#define VT_GETMODE 0x5601
#define VT_SETMODE 0x5602
#define VT_GETSTATE 0x5603
#define VT_RELDISP 0x5605
#define VT_ACTIVATE 0x5606
#define VT_WAITACTIVE 0x5607

struct input_id {
    uint16_t bustype;
    uint16_t vendor;
    uint16_t product;
    uint16_t version;
};

static int checks = 0;
static int failures = 0;

static void pass(const char *name) {
    checks++;
    printf("ok: %s\n", name);
}

static void passf(const char *fmt, ...) {
    checks++;
    printf("ok: ");
    va_list ap;
    va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
    printf("\n");
}

static void fail_errno(const char *name) {
    checks++;
    printf("fail: %s: %s\n", name, strerror(errno));
    failures++;
}

static void fail_msg(const char *name, const char *msg) {
    checks++;
    printf("fail: %s: %s\n", name, msg);
    failures++;
}

static void section(const char *name) {
    printf("fbseat-probe: [%s]\n", name);
}

static int bit_is_set(const unsigned char *bits, size_t len, unsigned bit) {
    size_t byte = bit / 8;
    return byte < len && (bits[byte] & (1u << (bit % 8))) != 0;
}

static int probe_event_device(const char *path, int expect_relative) {
    int fd = open(path, O_RDONLY | O_NONBLOCK);
    if (fd < 0) {
        fail_errno(path);
        return -1;
    }

    unsigned char buf[32];
    ssize_t n = read(fd, buf, sizeof(buf));
    if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
        fail_errno(path);
        close(fd);
        return -1;
    }

    passf("%s opened%s", path, n > 0 ? " and had queued input" : "");

    int version = 0;
    if (ioctl(fd, EVIOCGVERSION, &version) < 0) {
        fail_errno("EVIOCGVERSION");
    } else if (version != 0x010001) {
        fail_msg("EVIOCGVERSION", "unexpected version");
    } else {
        pass("EVIOCGVERSION");
    }

    struct input_id id;
    memset(&id, 0, sizeof(id));
    if (ioctl(fd, EVIOCGID, &id) < 0) {
        fail_errno("EVIOCGID");
    } else if (id.bustype != 0x06) {
        fail_msg("EVIOCGID", "unexpected bus type");
    } else {
        pass("EVIOCGID");
    }

    char name[64];
    memset(name, 0, sizeof(name));
    if (ioctl(fd, EVIOCGNAME(sizeof(name)), name) < 0) {
        fail_errno("EVIOCGNAME");
    } else if (name[0] == '\0') {
        fail_msg("EVIOCGNAME", "empty device name");
    } else {
        passf("EVIOCGNAME %s", name);
    }

    unsigned char ev_bits[4];
    memset(ev_bits, 0, sizeof(ev_bits));
    if (ioctl(fd, EVIOCGBIT(EV_SYN, sizeof(ev_bits)), ev_bits) < 0) {
        fail_errno("EVIOCGBIT event types");
    } else if (!bit_is_set(ev_bits, sizeof(ev_bits), EV_SYN) ||
               !bit_is_set(ev_bits, sizeof(ev_bits), EV_KEY) ||
               bit_is_set(ev_bits, sizeof(ev_bits), EV_REL) != expect_relative) {
        fail_msg("EVIOCGBIT event types", "unexpected event type bits");
    } else {
        pass("EVIOCGBIT event types");
    }

    if (expect_relative) {
        unsigned char rel_bits[2];
        unsigned char key_bits[64];
        memset(rel_bits, 0, sizeof(rel_bits));
        memset(key_bits, 0, sizeof(key_bits));
        if (ioctl(fd, EVIOCGBIT(EV_REL, sizeof(rel_bits)), rel_bits) < 0) {
            fail_errno("EVIOCGBIT relative axes");
        } else if (!bit_is_set(rel_bits, sizeof(rel_bits), REL_X) ||
                   !bit_is_set(rel_bits, sizeof(rel_bits), REL_Y) ||
                   !bit_is_set(rel_bits, sizeof(rel_bits), REL_WHEEL)) {
            fail_msg("EVIOCGBIT relative axes", "missing REL_X/REL_Y/REL_WHEEL");
        } else {
            pass("EVIOCGBIT relative axes");
        }
        if (ioctl(fd, EVIOCGBIT(EV_KEY, sizeof(key_bits)), key_bits) < 0) {
            fail_errno("EVIOCGBIT pointer buttons");
        } else if (!bit_is_set(key_bits, sizeof(key_bits), BTN_LEFT) ||
                   !bit_is_set(key_bits, sizeof(key_bits), BTN_RIGHT) ||
                   !bit_is_set(key_bits, sizeof(key_bits), BTN_MIDDLE)) {
            fail_msg("EVIOCGBIT pointer buttons", "missing mouse buttons");
        } else {
            pass("EVIOCGBIT pointer buttons");
        }
    } else {
        unsigned char key_bits[16];
        memset(key_bits, 0, sizeof(key_bits));
        if (ioctl(fd, EVIOCGBIT(EV_KEY, sizeof(key_bits)), key_bits) < 0) {
            fail_errno("EVIOCGBIT keyboard keys");
        } else if (!bit_is_set(key_bits, sizeof(key_bits), KEY_A) ||
                   !bit_is_set(key_bits, sizeof(key_bits), KEY_SPACE) ||
                   !bit_is_set(key_bits, sizeof(key_bits), KEY_UP)) {
            fail_msg("EVIOCGBIT keyboard keys", "missing common keys");
        } else {
            pass("EVIOCGBIT keyboard keys");
        }
    }

    close(fd);
    return 0;
}

static int probe_input_device(const char *path) {
    int fd = open(path, O_RDONLY | O_NONBLOCK);
    if (fd < 0) {
        fail_errno(path);
        return -1;
    }
    unsigned char buf[32];
    ssize_t n = read(fd, buf, sizeof(buf));
    if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
        fail_errno(path);
        close(fd);
        return -1;
    }
    passf("%s opened%s", path, n > 0 ? " and had queued input" : "");
    close(fd);
    return 0;
}

static int probe_vt_console(void) {
    int fd = open("/dev/tty0", O_RDWR | O_NONBLOCK);
    if (fd < 0) {
        fail_errno("/dev/tty0");
        return -1;
    }
    pass("/dev/tty0 open");

    int kd_mode = -1;
    if (ioctl(fd, KDGETMODE, &kd_mode) < 0) {
        fail_errno("KDGETMODE");
    } else if (kd_mode != KD_TEXT) {
        fail_msg("KDGETMODE", "unexpected mode");
    } else {
        pass("KDGETMODE");
    }

    if (ioctl(fd, KDSETMODE, KD_GRAPHICS) < 0) {
        fail_errno("KDSETMODE KD_GRAPHICS");
    } else {
        pass("KDSETMODE KD_GRAPHICS");
    }
    if (ioctl(fd, KDSETMODE, KD_TEXT) < 0) {
        fail_errno("KDSETMODE KD_TEXT");
    } else {
        pass("KDSETMODE KD_TEXT");
    }

    int vt = -1;
    if (ioctl(fd, VT_OPENQRY, &vt) < 0) {
        fail_errno("VT_OPENQRY");
    } else if (vt != 1) {
        fail_msg("VT_OPENQRY", "unexpected vt number");
    } else {
        pass("VT_OPENQRY");
    }

    unsigned char state[6];
    memset(state, 0, sizeof(state));
    if (ioctl(fd, VT_GETSTATE, state) < 0) {
        fail_errno("VT_GETSTATE");
    } else if (state[0] != 1 || state[4] != 2) {
        fail_msg("VT_GETSTATE", "unexpected active vt state");
    } else {
        pass("VT_GETSTATE");
    }

    unsigned char mode[8];
    memset(mode, 0xff, sizeof(mode));
    if (ioctl(fd, VT_GETMODE, mode) < 0) {
        fail_errno("VT_GETMODE");
    } else if (mode[0] != 0) {
        fail_msg("VT_GETMODE", "unexpected vt mode");
    } else {
        pass("VT_GETMODE");
    }

    if (ioctl(fd, VT_ACTIVATE, 1) < 0) {
        fail_errno("VT_ACTIVATE");
    } else {
        pass("VT_ACTIVATE");
    }
    if (ioctl(fd, VT_WAITACTIVE, 1) < 0) {
        fail_errno("VT_WAITACTIVE");
    } else {
        pass("VT_WAITACTIVE");
    }

    close(fd);
    return 0;
}

static uint32_t color_for(int x, int y, int w, int h) {
    int r = (x * 255) / (w > 1 ? w - 1 : 1);
    int g = (y * 255) / (h > 1 ? h - 1 : 1);
    int b = ((x / 32) ^ (y / 32)) & 1 ? 0x55 : 0xaa;
    return 0xff000000u | ((uint32_t)r << 16) | ((uint32_t)g << 8) | (uint32_t)b;
}

static int probe_framebuffer_mode(int fb, unsigned width, unsigned height) {
    char label[96];
    struct fb_var_screeninfo var;
    struct fb_fix_screeninfo fix;
    memset(&var, 0, sizeof(var));
    memset(&fix, 0, sizeof(fix));

    if (ioctl(fb, FBIOGET_VSCREENINFO, &var) < 0) {
        fail_errno("FBIOGET_VSCREENINFO before mode set");
        return -1;
    }

    var.xres = width;
    var.yres = height;
    var.xres_virtual = width;
    var.yres_virtual = height;
    var.bits_per_pixel = 32;
    snprintf(label, sizeof(label), "FBIOPUT_VSCREENINFO %ux%ux32", width, height);
    if (ioctl(fb, FBIOPUT_VSCREENINFO, &var) < 0) {
        fail_errno(label);
        return -1;
    }
    pass(label);

    if (ioctl(fb, FBIOGET_VSCREENINFO, &var) < 0) {
        fail_errno("FBIOGET_VSCREENINFO after mode set");
        return -1;
    }
    if (ioctl(fb, FBIOGET_FSCREENINFO, &fix) < 0) {
        fail_errno("FBIOGET_FSCREENINFO");
        return -1;
    }

    if (var.xres != width || var.yres != height || var.bits_per_pixel != 32 || fix.line_length < width * 4) {
        fail_msg("framebuffer geometry", "mode did not apply cleanly");
        return -1;
    }
    passf("framebuffer active %ux%u %u bpp stride=%u bytes len=%u",
          var.xres,
          var.yres,
          var.bits_per_pixel,
          fix.line_length,
          fix.smem_len);

    if (ioctl(fb, FBIOBLANK, FB_BLANK_UNBLANK) < 0) {
        fail_errno("FBIOBLANK");
    } else {
        pass("FBIOBLANK");
    }

    uint32_t crtc = 0;
    if (ioctl(fb, FBIO_WAITFORVSYNC, &crtc) < 0) {
        fail_errno("FBIO_WAITFORVSYNC");
    } else {
        pass("FBIO_WAITFORVSYNC");
    }

    size_t len = fix.smem_len;
    if (len == 0) {
        fail_msg("mmap /dev/fb0", "framebuffer length is zero");
        return -1;
    }

    uint32_t *pixels = mmap(NULL, len, PROT_READ | PROT_WRITE, MAP_SHARED, fb, 0);
    if (pixels == MAP_FAILED) {
        fail_errno("mmap /dev/fb0");
        return -1;
    }
    pass("mmap /dev/fb0");

    int w = (int)var.xres;
    int h = (int)var.yres;
    int stride = (int)(fix.line_length / 4);
    if (w <= 0 || h <= 0 || stride < w) {
        fail_msg("draw framebuffer", "unexpected framebuffer geometry");
    } else {
        for (int y = 0; y < h; y++) {
            uint32_t *row = pixels + y * stride;
            for (int x = 0; x < w; x++) {
                row[x] = color_for(x, y, w, h);
            }
        }
        passf("draw framebuffer %ux%u", width, height);
    }

    if (munmap(pixels, len) < 0) {
        fail_errno("munmap /dev/fb0");
    } else {
        pass("munmap /dev/fb0");
    }
    return 0;
}

int main(void) {
    printf("fbseat-probe: starting\n");

    section("framebuffer");
    int fb = open("/dev/fb0", O_RDWR);
    if (fb < 0) {
        fail_errno("/dev/fb0 open");
    } else {
        pass("/dev/fb0 open");

        struct fb_var_screeninfo initial;
        memset(&initial, 0, sizeof(initial));
        if (ioctl(fb, FBIOGET_VSCREENINFO, &initial) < 0) {
            fail_errno("FBIOGET_VSCREENINFO");
        } else {
            printf("fb: initial %ux%u %u bpp\n", initial.xres, initial.yres, initial.bits_per_pixel);
        }

        probe_framebuffer_mode(fb, 800, 600);
        usleep(200000);
        probe_framebuffer_mode(fb, 640, 480);

        close(fb);
    }

    section("evdev pointer");
    probe_event_device("/dev/input/event0", 1);
    section("evdev keyboard");
    probe_event_device("/dev/input/event1", 0);
    section("mousedev fallback");
    probe_input_device("/dev/input/mice");
    section("linux vt");
    probe_vt_console();

    if (failures == 0) {
        printf("fbseat-probe: PASS (%d checks)\n", checks);
        return 0;
    }
    printf("fbseat-probe: FAIL (%d/%d checks failed)\n", failures, checks);
    return 1;
}
