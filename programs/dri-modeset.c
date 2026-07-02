/*
 * dri-modeset — KMS page-flip test fixture for host/test/dri-modeset.test.ts.
 *
 * Replaces what programs/modeset.c used to be before commit 0357884bf
 * turned the demo binary into Pavel's fluid-sim. The vitest still
 * needs a short-lived libdrm/libgbm CLI that prints a "modeset OK"
 * summary and exits, so keep this trimmed-down fixture in tree
 * separately from the user-facing demo.
 *
 * Behavior — same as the pre-fluid modeset demo (§C2 of
 * docs/plans/2026-06-08-dri-kms-plan.md): opens card0 + renderD128,
 * takes DRM master, allocates a scanout bo via libgbm on renderD128,
 * cross-imports the handle into card0 via PRIME_FD_TO_HANDLE, wraps
 * it as a framebuffer (ADDFB2), sets the mode (SETCRTC), and then
 * runs a page-flip → vblank-event round-trip loop.
 *
 *   open card0 + renderD128 + SetMaster
 *   GetResources → crtc_id, connector_id
 *   GetConnector → mode (first entry)
 *   gbm_create_device(render) + gbm_bo_create(SCANOUT|LINEAR)
 *   PRIME export → PRIME_FD_TO_HANDLE on card0
 *   ADDFB2 → fb_id
 *   draw a known pattern via gbm_bo_map (so C3 can sample scanout)
 *   SetCrtc(fb_id, mode)
 *   loop FRAMES times: PageFlip(EVENT) + drmHandleEvent
 *   DropMaster
 *
 * exit 0 if every PageFlip + event round-trip succeeds, else 1.
 * argv[1] (optional) overrides FRAMES; default 5 keeps vitest fast.
 *
 * The kernel always queues a flip into pending_flips and the vblank
 * pump drains it into the event ring regardless of the PAGE_FLIP_EVENT
 * flag (see handoff-58 — v1 simplification). We still pass the flag
 * to match real DRM semantics and to match what SDL2 KMSDRM does.
 */
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#include <drm/drm.h>
#include <drm/drm_mode.h>
#include <drm/drm_fourcc.h>
#include <gbm.h>
#include <xf86drm.h>
#include <xf86drmMode.h>

#define FAIL(msg) do { perror(msg); return 1; } while (0)

static int g_events = 0;

static void on_flip(int fd, unsigned int seq, unsigned int sec,
                    unsigned int usec, void *user_data) {
    (void) fd; (void) seq; (void) sec; (void) usec; (void) user_data;
    g_events++;
}

int main(int argc, char **argv) {
    int frames = (argc >= 2) ? atoi(argv[1]) : 5;
    if (frames <= 0) frames = 5;

    int card = open("/dev/dri/card0", O_RDWR | O_CLOEXEC);
    if (card < 0) FAIL("open /dev/dri/card0");
    int render = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC);
    if (render < 0) FAIL("open /dev/dri/renderD128");

    if (drmSetMaster(card) < 0) FAIL("drmSetMaster");

    drmModeResPtr res = drmModeGetResources(card);
    if (!res) FAIL("drmModeGetResources");
    if (res->count_crtcs < 1 || res->count_connectors < 1) {
        fprintf(stderr, "FAIL: no crtc/connector\n");
        return 1;
    }
    uint32_t crtc_id = res->crtcs[0];
    uint32_t connector_id = res->connectors[0];

    drmModeConnectorPtr conn = drmModeGetConnector(card, connector_id);
    if (!conn || conn->count_modes < 1) FAIL("drmModeGetConnector");
    drmModeModeInfo mode = conn->modes[0];
    uint32_t W = mode.hdisplay ? mode.hdisplay : 64;
    uint32_t H = mode.vdisplay ? mode.vdisplay : 64;

    struct gbm_device *gbm = gbm_create_device(render);
    if (!gbm) FAIL("gbm_create_device");
    struct gbm_bo *bo = gbm_bo_create(gbm, W, H, GBM_FORMAT_XRGB8888,
                                      GBM_BO_USE_SCANOUT | GBM_BO_USE_LINEAR);
    if (!bo) FAIL("gbm_bo_create");

    uint32_t stride = 0;
    void *map_data = NULL;
    uint32_t *px = gbm_bo_map(bo, 0, 0, W, H, 0, &stride, &map_data);
    if (!px || !stride) FAIL("gbm_bo_map");
    /* Paint a known XRGB pattern — solid blue (0x000000FF). The C3 e2e
     * samples the top-left pixel via kernel.kms.scanoutBytes() to prove
     * the SETCRTC → host_kms_set_fb path landed the right bo. */
    const uint32_t stride_px = stride / 4;
    for (uint32_t y = 0; y < H; y++) {
        for (uint32_t x = 0; x < W; x++) {
            px[y * stride_px + x] = 0x000000FFu;
        }
    }
    gbm_bo_unmap(bo, map_data);

    int prime = gbm_bo_get_fd(bo);
    if (prime < 0) FAIL("gbm_bo_get_fd");

    struct drm_prime_handle p;
    memset(&p, 0, sizeof(p));
    p.fd = prime;
    if (drmIoctl(card, DRM_IOCTL_PRIME_FD_TO_HANDLE, &p) < 0)
        FAIL("PRIME_FD_TO_HANDLE");

    uint32_t handles[4] = { p.handle, 0, 0, 0 };
    uint32_t pitches[4] = { stride, 0, 0, 0 };
    uint32_t offsets[4] = { 0, 0, 0, 0 };
    uint32_t fb_id = 0;
    if (drmModeAddFB2(card, W, H, DRM_FORMAT_XRGB8888,
                      handles, pitches, offsets, &fb_id, 0) < 0)
        FAIL("drmModeAddFB2");

    if (drmModeSetCrtc(card, crtc_id, fb_id, 0, 0,
                       &connector_id, 1, &mode) < 0)
        FAIL("drmModeSetCrtc");

    drmEventContext ctx;
    memset(&ctx, 0, sizeof(ctx));
    ctx.version = 2;
    ctx.page_flip_handler = on_flip;

    for (int i = 0; i < frames; i++) {
        if (drmModePageFlip(card, crtc_id, fb_id,
                            DRM_MODE_PAGE_FLIP_EVENT,
                            (void *)(uintptr_t) i) < 0)
            FAIL("drmModePageFlip");
        if (drmHandleEvent(card, &ctx) < 0)
            FAIL("drmHandleEvent");
    }

    if (g_events != frames) {
        fprintf(stderr, "FAIL: events=%d expected=%d\n", g_events, frames);
        return 1;
    }

    drmModeFreeConnector(conn);
    drmModeFreeResources(res);
    drmModeRmFB(card, fb_id);
    drmDropMaster(card);

    printf("modeset OK frames=%d w=%u h=%u\n", g_events, W, H);
    return 0;
}
