/*
 * kms-pageflip-smoke — page-flip round-trip on /dev/dri/card0.
 * Used by host/test/dri-kms-pageflip.test.ts.
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

#define DRM_FORMAT_XRGB8888 0x34325258u

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

    struct drm_mode_create_dumb cd;
    memset(&cd, 0, sizeof(cd));
    cd.width = 256; cd.height = 256; cd.bpp = 32;
    if (ioctl(fd, DRM_IOCTL_MODE_CREATE_DUMB, &cd) < 0) {
        perror("CREATE_DUMB"); return 1;
    }

    struct drm_mode_fb_cmd2 fb;
    memset(&fb, 0, sizeof(fb));
    fb.width = 256; fb.height = 256;
    fb.pixel_format = DRM_FORMAT_XRGB8888;
    fb.handles[0] = cd.handle;
    fb.pitches[0] = cd.pitch;
    if (ioctl(fd, DRM_IOCTL_MODE_ADDFB2, &fb) < 0) {
        perror("ADDFB2"); return 1;
    }

    struct drm_mode_crtc_page_flip pf;
    memset(&pf, 0, sizeof(pf));
    pf.crtc_id = 1; pf.fb_id = fb.fb_id;
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
