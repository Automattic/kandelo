/*
 * wldmabuf-test — the PR11 gate's Wayland client. A minimal raw
 * libwayland-client program that drives wlcompositor's zwp_linux_dmabuf_v1
 * path so host/test/wlcompositor-dmabuf-smoke.test.ts can assert the
 * compositor imports and composites a dmabuf-supplied buffer:
 *
 *   1. connect, bind the globals it needs (wl_compositor, zwp_linux_dmabuf_v1,
 *      xdg_wm_base), and confirm the dmabuf advertises XRGB8888 + LINEAR.
 *   2. create an xdg_toplevel, ack the compositor's configure.
 *   3. allocate a renderD128 dumb-bo, paint it solid red, and turn its
 *      prime-fd into a wl_buffer via zwp_linux_buffer_params_v1.create_immed
 *      (offset 0, LINEAR) — the dmabuf equivalent of wlclient-test's wl_shm
 *      pool, exercising the GPU-tier client-buffer path (PR10 §7.1).
 *   4. attach + commit + request a frame callback; when it fires, the
 *      compositor has imported our dmabuf and flipped it onto card0.
 *
 * Prints markers the test asserts and exits 0; the compositor exits 0 once
 * we disconnect. Input routing is covered by wlclient-test — this gate is
 * purely the dmabuf buffer path.
 */
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <wayland-client.h>
#include <wayland-client-protocol.h>
#include "xdg-shell-client-protocol.h"
#include "linux-dmabuf-v1-client-protocol.h"

#include <gbm.h>
#include <drm/drm_fourcc.h>

#define WL_SOCKET_PATH "/tmp/wayland-0"
#define WIN_W 200
#define WIN_H 150
#define RED   0x00ff0000u   /* XRGB8888: opaque red (X byte ignored) */

struct client {
    struct wl_compositor *compositor;
    struct zwp_linux_dmabuf_v1 *dmabuf;
    struct xdg_wm_base *wm_base;

    struct wl_surface *surface;
    struct xdg_surface *xdg_surface;
    struct xdg_toplevel *toplevel;

    int configured;      /* got + acked the initial xdg configure */
    int frame_done;      /* compositor imported + flipped our buffer */
    int saw_xrgb_linear; /* dmabuf advertised XRGB8888 with LINEAR */
};

/* ---- zwp_linux_dmabuf_v1: format/modifier advertisement ---------------- */

static void dmabuf_format(void *data, struct zwp_linux_dmabuf_v1 *d,
                          uint32_t format) {}
static void dmabuf_modifier(void *data, struct zwp_linux_dmabuf_v1 *d,
                            uint32_t format, uint32_t mod_hi, uint32_t mod_lo) {
    struct client *c = data;
    uint64_t mod = ((uint64_t)mod_hi << 32) | mod_lo;
    if (format == DRM_FORMAT_XRGB8888 && mod == DRM_FORMAT_MOD_LINEAR)
        c->saw_xrgb_linear = 1;
}
static const struct zwp_linux_dmabuf_v1_listener dmabuf_listener = {
    .format = dmabuf_format,
    .modifier = dmabuf_modifier,
};

/* ---- registry ---------------------------------------------------------- */

static void registry_global(void *data, struct wl_registry *reg, uint32_t name,
                            const char *iface, uint32_t version) {
    struct client *c = data;
    if (strcmp(iface, "wl_compositor") == 0)
        c->compositor = wl_registry_bind(reg, name, &wl_compositor_interface,
                                         version < 4 ? version : 4);
    else if (strcmp(iface, "zwp_linux_dmabuf_v1") == 0) {
        c->dmabuf = wl_registry_bind(reg, name, &zwp_linux_dmabuf_v1_interface,
                                     version < 3 ? version : 3);
        zwp_linux_dmabuf_v1_add_listener(c->dmabuf, &dmabuf_listener, c);
    } else if (strcmp(iface, "xdg_wm_base") == 0)
        c->wm_base = wl_registry_bind(reg, name, &xdg_wm_base_interface, 1);
}
static void registry_global_remove(void *data, struct wl_registry *r,
                                   uint32_t name) {}
static const struct wl_registry_listener registry_listener = {
    .global = registry_global,
    .global_remove = registry_global_remove,
};

/* ---- xdg_shell --------------------------------------------------------- */

static void wm_base_ping(void *data, struct xdg_wm_base *b, uint32_t serial) {
    xdg_wm_base_pong(b, serial);
}
static const struct xdg_wm_base_listener wm_base_listener = {
    .ping = wm_base_ping,
};
static void xdg_surface_configure(void *data, struct xdg_surface *xs,
                                  uint32_t serial) {
    struct client *c = data;
    xdg_surface_ack_configure(xs, serial);
    c->configured = 1;
}
static const struct xdg_surface_listener xdg_surface_listener = {
    .configure = xdg_surface_configure,
};
static void toplevel_configure(void *data, struct xdg_toplevel *t, int32_t w,
                               int32_t h, struct wl_array *states) {}
static void toplevel_close(void *data, struct xdg_toplevel *t) {}
static const struct xdg_toplevel_listener toplevel_listener = {
    .configure = toplevel_configure,
    .close = toplevel_close,
};

/* ---- frame callback ---------------------------------------------------- */

static void frame_done(void *data, struct wl_callback *cb, uint32_t t) {
    struct client *c = data;
    c->frame_done = 1;
    wl_callback_destroy(cb);
}
static const struct wl_callback_listener frame_listener = {
    .done = frame_done,
};

/* ---- helpers ----------------------------------------------------------- */

static int connect_socket(void) {
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) { perror("socket"); return -1; }
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, WL_SOCKET_PATH, sizeof(addr.sun_path) - 1);
    for (int i = 0; i < 100; i++) {
        if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) == 0)
            return fd;
        usleep(10000);
    }
    perror("connect");
    close(fd);
    return -1;
}

/* Allocate a renderD128 dumb-bo, paint it red, and wrap its prime-fd as a
 * dmabuf wl_buffer via zwp_linux_buffer_params_v1. Returns the wl_buffer. */
static struct wl_buffer *make_dmabuf_buffer(struct client *c) {
    int render = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC);
    if (render < 0) { perror("open renderD128"); return NULL; }
    struct gbm_device *gbm = gbm_create_device(render);
    if (!gbm) { fprintf(stderr, "gbm_create_device\n"); return NULL; }
    struct gbm_bo *bo = gbm_bo_create(gbm, WIN_W, WIN_H, GBM_FORMAT_XRGB8888,
                                      GBM_BO_USE_LINEAR | GBM_BO_USE_SCANOUT);
    if (!bo) { fprintf(stderr, "gbm_bo_create\n"); return NULL; }

    uint32_t stride = 0;
    void *map_data = NULL;
    uint32_t *px = gbm_bo_map(bo, 0, 0, WIN_W, WIN_H, 0, &stride, &map_data);
    if (!px) { fprintf(stderr, "gbm_bo_map\n"); return NULL; }
    uint32_t stride_px = stride / 4;
    for (int y = 0; y < WIN_H; y++)
        for (int x = 0; x < WIN_W; x++)
            px[y * stride_px + x] = RED;
    gbm_bo_unmap(bo, map_data);

    int prime = gbm_bo_get_fd(bo);
    if (prime < 0) { fprintf(stderr, "gbm_bo_get_fd\n"); return NULL; }

    struct zwp_linux_buffer_params_v1 *params =
        zwp_linux_dmabuf_v1_create_params(c->dmabuf);
    zwp_linux_buffer_params_v1_add(
        params, prime, 0, 0, stride,
        (uint32_t)(DRM_FORMAT_MOD_LINEAR >> 32),
        (uint32_t)(DRM_FORMAT_MOD_LINEAR & 0xffffffffu));
    struct wl_buffer *buf = zwp_linux_buffer_params_v1_create_immed(
        params, WIN_W, WIN_H, DRM_FORMAT_XRGB8888, 0);
    zwp_linux_buffer_params_v1_destroy(params);
    close(prime);   /* the compositor dup'd it into its own bo */
    printf("DMABUF_BUFFER stride=%u\n", stride);
    fflush(stdout);
    return buf;
}

int main(void) {
    struct client c;
    memset(&c, 0, sizeof(c));

    int fd = connect_socket();
    if (fd < 0) return 1;
    struct wl_display *display = wl_display_connect_to_fd(fd);
    if (!display) { fprintf(stderr, "wl_display_connect_to_fd\n"); return 1; }

    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, &c);
    wl_display_roundtrip(display);   /* receive globals */
    wl_display_roundtrip(display);   /* receive dmabuf format/modifier events */

    if (!c.compositor || !c.dmabuf || !c.wm_base) {
        fprintf(stderr, "missing globals: comp=%p dmabuf=%p wm=%p\n",
                (void *)c.compositor, (void *)c.dmabuf, (void *)c.wm_base);
        return 1;
    }
    if (!c.saw_xrgb_linear) {
        fprintf(stderr, "dmabuf never advertised XRGB8888 + LINEAR\n");
        return 1;
    }
    printf("BOUND_ALL\n");
    fflush(stdout);

    xdg_wm_base_add_listener(c.wm_base, &wm_base_listener, &c);

    c.surface = wl_compositor_create_surface(c.compositor);
    c.xdg_surface = xdg_wm_base_get_xdg_surface(c.wm_base, c.surface);
    xdg_surface_add_listener(c.xdg_surface, &xdg_surface_listener, &c);
    c.toplevel = xdg_surface_get_toplevel(c.xdg_surface);
    xdg_toplevel_add_listener(c.toplevel, &toplevel_listener, &c);
    xdg_toplevel_set_title(c.toplevel, "wldmabuf-test");
    wl_surface_commit(c.surface);

    while (!c.configured)
        if (wl_display_dispatch(display) < 0) { fprintf(stderr, "dispatch\n"); return 1; }
    printf("CONFIGURED\n");
    fflush(stdout);

    struct wl_buffer *buffer = make_dmabuf_buffer(&c);
    if (!buffer) return 1;

    wl_surface_attach(c.surface, buffer, 0, 0);
    wl_surface_damage(c.surface, 0, 0, WIN_W, WIN_H);
    struct wl_callback *frame = wl_surface_frame(c.surface);
    wl_callback_add_listener(frame, &frame_listener, &c);
    wl_surface_commit(c.surface);

    while (!c.frame_done)
        if (wl_display_dispatch(display) < 0) { fprintf(stderr, "dispatch\n"); return 1; }
    printf("DMABUF_CLIENT_OK\n");
    fflush(stdout);

    wl_display_disconnect(display);
    return 0;
}
