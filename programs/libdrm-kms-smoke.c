/*
 * libdrm-kms-smoke — exercise the C1 libdrm KMS wrappers against
 * /dev/dri/card0. Prints "OK" on success.
 * Used by host/test/dri-libdrm-kms.test.ts.
 */
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include <drm/drm.h>
#include <drm/drm_mode.h>
#include <xf86drm.h>
#include <xf86drmMode.h>

#define DRM_FORMAT_XRGB8888 0x34325258u

#define CHECK(cond, msg) do { \
    if (!(cond)) { fprintf(stderr, "FAIL: " msg "\n"); return 1; } \
} while (0)

int main(void) {
    int fd = open("/dev/dri/card0", O_RDWR);
    if (fd < 0) { perror("open card0"); return 1; }

    CHECK(drmSetMaster(fd) == 0, "drmSetMaster");

    drmModeResPtr res = drmModeGetResources(fd);
    CHECK(res, "drmModeGetResources");
    CHECK(res->count_crtcs >= 1, "count_crtcs");
    CHECK(res->count_connectors >= 1, "count_connectors");
    CHECK(res->count_encoders >= 1, "count_encoders");
    CHECK(res->crtcs[0] == 1, "crtcs[0]");
    CHECK(res->connectors[0] == 1, "connectors[0]");
    CHECK(res->encoders[0] == 1, "encoders[0]");
    uint32_t crtc_id = res->crtcs[0];
    uint32_t conn_id = res->connectors[0];
    uint32_t enc_id  = res->encoders[0];

    drmModeConnectorPtr conn = drmModeGetConnector(fd, conn_id);
    CHECK(conn, "drmModeGetConnector");
    CHECK(conn->connector_id == conn_id, "connector_id");
    CHECK(conn->connection == DRM_MODE_CONNECTED, "connection");
    CHECK(conn->count_modes >= 1, "count_modes");

    drmModeEncoderPtr enc = drmModeGetEncoder(fd, enc_id);
    CHECK(enc, "drmModeGetEncoder");
    CHECK(enc->crtc_id == crtc_id, "encoder.crtc_id");

    drmModeCrtcPtr crtc = drmModeGetCrtc(fd, crtc_id);
    CHECK(crtc, "drmModeGetCrtc");
    CHECK(crtc->crtc_id == crtc_id, "crtc.crtc_id");

    struct drm_mode_create_dumb cd;
    memset(&cd, 0, sizeof(cd));
    cd.width = 64; cd.height = 64; cd.bpp = 32;
    CHECK(ioctl(fd, DRM_IOCTL_MODE_CREATE_DUMB, &cd) == 0, "CREATE_DUMB");

    uint32_t handles[4] = { cd.handle, 0, 0, 0 };
    uint32_t pitches[4] = { cd.pitch,  0, 0, 0 };
    uint32_t offsets[4] = { 0, 0, 0, 0 };
    uint32_t fb_id = 0;
    CHECK(drmModeAddFB2(fd, 64, 64, DRM_FORMAT_XRGB8888,
                        handles, pitches, offsets, &fb_id, 0) == 0,
          "drmModeAddFB2");
    CHECK(fb_id != 0, "fb_id != 0");

    CHECK(drmModeRmFB(fd, fb_id) == 0, "drmModeRmFB");

    drmModeFreeCrtc(crtc);
    drmModeFreeEncoder(enc);
    drmModeFreeConnector(conn);
    drmModeFreeResources(res);

    CHECK(drmDropMaster(fd) == 0, "drmDropMaster");

    printf("OK\n");
    return 0;
}
