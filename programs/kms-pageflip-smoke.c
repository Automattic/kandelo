/*
 * kms-pageflip-smoke — page-flip round-trip on /dev/dri/card0.
 * Used by host/test/dri-kms-pageflip.test.ts.
 *
 * Follows the Linux uAPI: a flip needs a CRTC already scanning out (an
 * unbound CRTC answers EBUSY), an fb that covers the mode, and
 * DRM_MODE_PAGE_FLIP_EVENT to receive a completion event.
 */
#include <fcntl.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#define DRM_IOCTL_SET_MASTER       0x0000641eu
#define DRM_IOCTL_MODE_CREATE_DUMB 0xc02064b2u
#define DRM_IOCTL_MODE_ADDFB2      0xc06864b8u
#define DRM_IOCTL_MODE_PAGE_FLIP   0xc01864b0u
#define DRM_IOCTL_MODE_GETCONNECTOR 0xc05064a7u
#define DRM_IOCTL_MODE_SETCRTC     0xc06864a2u

#define DRM_FORMAT_XRGB8888 0x34325258u
#define DRM_MODE_PAGE_FLIP_EVENT 0x01u
#define CONNECTOR_ID 3u
#define MAX_MODES 64

struct drm_mode_modeinfo {
    uint32_t clock;
    uint16_t hdisplay, hsync_start, hsync_end, htotal, hskew;
    uint16_t vdisplay, vsync_start, vsync_end, vtotal, vscan;
    uint32_t vrefresh, flags, type;
    char name[32];
};

struct drm_mode_get_connector {
    uint64_t encoders_ptr, modes_ptr, props_ptr, prop_values_ptr;
    uint32_t count_modes, count_props, count_encoders, encoder_id;
    uint32_t connector_id, connector_type, connector_type_id, connection;
    uint32_t mm_width, mm_height, subpixel, pad;
};

struct drm_mode_crtc {
    uint64_t set_connectors_ptr;
    uint32_t count_connectors, crtc_id, fb_id, x, y, gamma_size, mode_valid;
    struct drm_mode_modeinfo mode;
};

struct drm_mode_create_dumb {
    uint32_t height, width, bpp, flags;
    uint32_t handle, pitch;
    uint64_t size;
};

struct drm_mode_fb_cmd2 {
    uint32_t fb_id, width, height, pixel_format, flags;
    uint32_t handles[4], pitches[4], offsets[4];
    uint64_t modifier[4];
};

struct drm_mode_crtc_page_flip {
    uint32_t crtc_id, fb_id, flags, reserved;
    uint64_t user_data;
};

struct drm_event_vblank {
    uint32_t ev_type, length;
    uint64_t user_data;
    uint32_t tv_sec, tv_usec, sequence, crtc_id;
};

int main(void) {
    int fd = open("/dev/dri/card0", O_RDWR);
    if (fd < 0) { perror("open card0"); return 1; }
    if (ioctl(fd, DRM_IOCTL_SET_MASTER, 0) < 0) {
        perror("SET_MASTER"); return 1;
    }

    /* The smallest advertised mode keeps the scanout buffer small. */
    static struct drm_mode_modeinfo modes[MAX_MODES];
    struct drm_mode_get_connector conn;
    memset(&conn, 0, sizeof(conn));
    conn.connector_id = CONNECTOR_ID;
    conn.count_modes = MAX_MODES;
    conn.modes_ptr = (uint64_t)(uintptr_t)modes;
    if (ioctl(fd, DRM_IOCTL_MODE_GETCONNECTOR, &conn) < 0) {
        perror("GETCONNECTOR"); return 1;
    }
    if (conn.count_modes == 0 || conn.count_modes > MAX_MODES) {
        fprintf(stderr, "unexpected mode count %u\n", conn.count_modes); return 1;
    }
    struct drm_mode_modeinfo mode = modes[0];
    for (uint32_t i = 1; i < conn.count_modes; i++) {
        if ((uint64_t)modes[i].hdisplay * modes[i].vdisplay
            < (uint64_t)mode.hdisplay * mode.vdisplay) mode = modes[i];
    }

    struct drm_mode_create_dumb cd;
    memset(&cd, 0, sizeof(cd));
    cd.width = mode.hdisplay; cd.height = mode.vdisplay; cd.bpp = 32;
    if (ioctl(fd, DRM_IOCTL_MODE_CREATE_DUMB, &cd) < 0) {
        perror("CREATE_DUMB"); return 1;
    }

    struct drm_mode_fb_cmd2 fb;
    memset(&fb, 0, sizeof(fb));
    fb.width = mode.hdisplay; fb.height = mode.vdisplay;
    fb.pixel_format = DRM_FORMAT_XRGB8888;
    fb.handles[0] = cd.handle;
    fb.pitches[0] = cd.pitch;
    if (ioctl(fd, DRM_IOCTL_MODE_ADDFB2, &fb) < 0) {
        perror("ADDFB2"); return 1;
    }

    uint32_t connector_id = CONNECTOR_ID;
    struct drm_mode_crtc crtc;
    memset(&crtc, 0, sizeof(crtc));
    crtc.crtc_id = 1; crtc.fb_id = fb.fb_id;
    crtc.set_connectors_ptr = (uint64_t)(uintptr_t)&connector_id;
    crtc.count_connectors = 1;
    crtc.mode_valid = 1; crtc.mode = mode;
    if (ioctl(fd, DRM_IOCTL_MODE_SETCRTC, &crtc) < 0) {
        perror("SETCRTC"); return 1;
    }

    struct drm_mode_crtc_page_flip pf;
    memset(&pf, 0, sizeof(pf));
    pf.crtc_id = 1; pf.fb_id = fb.fb_id;
    pf.flags = DRM_MODE_PAGE_FLIP_EVENT;
    pf.user_data = 0xdeadbeefcafe1234ull;
    if (ioctl(fd, DRM_IOCTL_MODE_PAGE_FLIP, &pf) < 0) {
        perror("PAGE_FLIP"); return 1;
    }

    struct pollfd pfd = { .fd = fd, .events = POLLIN };
    if (poll(&pfd, 1, 2000) <= 0) { perror("poll"); return 1; }

    struct drm_event_vblank ev;
    if (read(fd, &ev, sizeof(ev)) != (ssize_t)sizeof(ev)) {
        fprintf(stderr, "short read\n"); return 1;
    }

    printf("event type=%u length=%u user_data=0x%016llx seq=%u crtc=%u\n",
           ev.ev_type, ev.length,
           (unsigned long long)ev.user_data, ev.sequence, ev.crtc_id);
    return 0;
}
