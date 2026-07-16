/*
 * wlclient-test — the PR6 gate's Wayland client. A minimal, raw
 * libwayland-client program (NOT the PR7 libkwl toolkit) that drives the
 * wlcompositor server end-to-end so host/test/wlcompositor-smoke.test.ts
 * can assert the compositor actually composites and routes input:
 *
 *   1. connect to /run/wayland-0, bind the v1 globals (wl_compositor,
 *      wl_shm, xdg_wm_base, wl_seat, wl_output).
 *   2. create an xdg_toplevel, ack the compositor's configure.
 *   3. allocate a renderD128 dumb-bo, paint it solid red, and hand its
 *      prime-fd to wl_shm as the pool — the shared-buffer path that lets
 *      the compositor read the client's pixels (plan §8.1 gbm_bo_import).
 *   4. attach + commit + request a frame callback; when the callback
 *      fires, the compositor has flipped our pixels onto card0.
 *   5. compile the wl_keyboard keymap fd (proving the compositor's
 *      libxkbcommon keymap path) and receive a host-injected key + a
 *      pointer button, forwarded by the compositor from libinput.
 *
 * Prints markers the test asserts and exits 0. The compositor exits 0
 * once we disconnect.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <wayland-client.h>
#include <wayland-client-protocol.h>
#include "xdg-shell-client-protocol.h"
#include "xdg-decoration-v1-client-protocol.h"

#include <gbm.h>

#define WL_SOCKET_PATH "/tmp/wayland-0"
#define WIN_W 200
#define WIN_H 150
#define RED   0x00ff0000u   /* XRGB8888: opaque red (X byte ignored) */

struct client {
    struct wl_compositor *compositor;
    struct wl_shm *shm;
    struct xdg_wm_base *wm_base;
    struct wl_seat *seat;
    struct wl_output *output;
    struct zxdg_decoration_manager_v1 *decor_mgr;

    struct wl_surface *surface;
    struct xdg_surface *xdg_surface;
    struct xdg_toplevel *toplevel;

    int configured;     /* got + acked the initial xdg configure */
    int frame_done;     /* compositor flipped our buffer */
    int got_keymap;     /* wl_keyboard.keymap arrived + parsed */
    int got_key;        /* wl_keyboard.key arrived */
    uint32_t key_code, key_state;
    int got_button;     /* wl_pointer.button arrived */
    uint32_t btn_code, btn_state;
};

/* ---- registry ---------------------------------------------------------- */

static void registry_global(void *data, struct wl_registry *reg, uint32_t name,
                            const char *iface, uint32_t version) {
    struct client *c = data;
    if (strcmp(iface, "wl_compositor") == 0)
        c->compositor = wl_registry_bind(reg, name, &wl_compositor_interface,
                                         version < 4 ? version : 4);
    else if (strcmp(iface, "wl_shm") == 0)
        c->shm = wl_registry_bind(reg, name, &wl_shm_interface, 1);
    else if (strcmp(iface, "xdg_wm_base") == 0)
        c->wm_base = wl_registry_bind(reg, name, &xdg_wm_base_interface, 1);
    else if (strcmp(iface, "wl_seat") == 0)
        c->seat = wl_registry_bind(reg, name, &wl_seat_interface, 1);
    else if (strcmp(iface, "wl_output") == 0)
        c->output = wl_registry_bind(reg, name, &wl_output_interface, 2);
    else if (strcmp(iface, "zxdg_decoration_manager_v1") == 0)
        c->decor_mgr = wl_registry_bind(
            reg, name, &zxdg_decoration_manager_v1_interface, 1);
}

/* ---- xdg-decoration ---------------------------------------------------- */

static void decor_configure(void *data, struct zxdg_toplevel_decoration_v1 *d,
                            uint32_t mode) {
    printf("DECOR_MODE %s\n",
           mode == ZXDG_TOPLEVEL_DECORATION_V1_MODE_SERVER_SIDE ? "server_side"
                                                                : "client_side");
    fflush(stdout);
}
static const struct zxdg_toplevel_decoration_v1_listener decor_listener = {
    .configure = decor_configure,
};
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

/* ---- keyboard ---------------------------------------------------------- */

static void kbd_keymap(void *data, struct wl_keyboard *k, uint32_t format,
                       int32_t fd, uint32_t size) {
    struct client *c = data;
    /* Read-only map of the keymap the compositor built via libxkbcommon.
     * The bytes are the file's contents (no cross-process sharing needed);
     * we assert it is a real xkb keymap. */
    char *map = mmap(NULL, size, PROT_READ, MAP_PRIVATE, fd, 0);
    if (map != MAP_FAILED) {
        if (format == WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1 &&
            strncmp(map, "xkb_keymap", 10) == 0)
            c->got_keymap = 1;
        munmap(map, size);
    }
    close(fd);
    printf("KEYMAP format=%u size=%u ok=%d\n", format, size, c->got_keymap);
    fflush(stdout);
}
static void kbd_enter(void *data, struct wl_keyboard *k, uint32_t serial,
                      struct wl_surface *surf, struct wl_array *keys) {}
static void kbd_leave(void *data, struct wl_keyboard *k, uint32_t serial,
                      struct wl_surface *surf) {}
static void kbd_key(void *data, struct wl_keyboard *k, uint32_t serial,
                    uint32_t time, uint32_t key, uint32_t state) {
    struct client *c = data;
    c->got_key = 1;
    c->key_code = key;
    c->key_state = state;
    printf("GOT_KEY key=%u state=%u\n", key, state);
    fflush(stdout);
}
static void kbd_modifiers(void *data, struct wl_keyboard *k, uint32_t serial,
                          uint32_t dep, uint32_t lat, uint32_t lock,
                          uint32_t group) {}
static void kbd_repeat_info(void *data, struct wl_keyboard *k, int32_t rate,
                            int32_t delay) {}
static const struct wl_keyboard_listener keyboard_listener = {
    .keymap = kbd_keymap,
    .enter = kbd_enter,
    .leave = kbd_leave,
    .key = kbd_key,
    .modifiers = kbd_modifiers,
    .repeat_info = kbd_repeat_info,
};

/* ---- pointer ----------------------------------------------------------- */

static void ptr_enter(void *data, struct wl_pointer *p, uint32_t serial,
                      struct wl_surface *surf, wl_fixed_t x, wl_fixed_t y) {}
static void ptr_leave(void *data, struct wl_pointer *p, uint32_t serial,
                      struct wl_surface *surf) {}
static void ptr_motion(void *data, struct wl_pointer *p, uint32_t time,
                       wl_fixed_t x, wl_fixed_t y) {
    printf("GOT_MOTION x=%d y=%d\n", wl_fixed_to_int(x), wl_fixed_to_int(y));
    fflush(stdout);
}
static void ptr_button(void *data, struct wl_pointer *p, uint32_t serial,
                       uint32_t time, uint32_t button, uint32_t state) {
    struct client *c = data;
    c->got_button = 1;
    c->btn_code = button;
    c->btn_state = state;
    printf("GOT_BTN button=%u state=%u\n", button, state);
    fflush(stdout);
}
static void ptr_axis(void *data, struct wl_pointer *p, uint32_t time,
                     uint32_t axis, wl_fixed_t value) {}
static const struct wl_pointer_listener pointer_listener = {
    .enter = ptr_enter,
    .leave = ptr_leave,
    .motion = ptr_motion,
    .button = ptr_button,
    .axis = ptr_axis,
};

/* ---- helpers ----------------------------------------------------------- */

static int connect_socket(void) {
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) { perror("socket"); return -1; }
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, WL_SOCKET_PATH, sizeof(addr.sun_path) - 1);
    /* The compositor binds before printing COMPOSITOR_UP, but retry a few
     * times to be robust against spawn ordering. */
    for (int i = 0; i < 100; i++) {
        if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) == 0)
            return fd;
        usleep(10000);
    }
    perror("connect");
    close(fd);
    return -1;
}

/* Allocate a renderD128 dumb-bo, paint it, and wrap it as a wl_shm buffer
 * whose pool fd is the bo's prime-fd — the shared path the compositor
 * imports. Returns the wl_buffer (bo kept alive for its lifetime). */
static struct wl_buffer *make_buffer(struct client *c) {
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

    struct wl_shm_pool *pool =
        wl_shm_create_pool(c->shm, prime, (int32_t)(stride * WIN_H));
    struct wl_buffer *buf = wl_shm_pool_create_buffer(
        pool, 0, WIN_W, WIN_H, (int32_t)stride, WL_SHM_FORMAT_XRGB8888);
    wl_shm_pool_destroy(pool);   /* the buffer keeps the pool alive */
    close(prime);                /* wl_shm dup'd it into the pool */
    printf("BUFFER stride=%u\n", stride);
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
    wl_display_roundtrip(display);   /* receive their initial events */

    if (!c.compositor || !c.shm || !c.wm_base || !c.seat || !c.output) {
        fprintf(stderr, "missing globals: comp=%p shm=%p wm=%p seat=%p out=%p\n",
                (void *)c.compositor, (void *)c.shm, (void *)c.wm_base,
                (void *)c.seat, (void *)c.output);
        return 1;
    }
    printf("BOUND_ALL\n");
    fflush(stdout);

    xdg_wm_base_add_listener(c.wm_base, &wm_base_listener, &c);

    /* Seat inputs first, so the compositor's map-time focus reaches them. */
    struct wl_keyboard *kbd = wl_seat_get_keyboard(c.seat);
    wl_keyboard_add_listener(kbd, &keyboard_listener, &c);
    struct wl_pointer *ptr = wl_seat_get_pointer(c.seat);
    wl_pointer_add_listener(ptr, &pointer_listener, &c);

    /* Toplevel. */
    c.surface = wl_compositor_create_surface(c.compositor);
    c.xdg_surface = xdg_wm_base_get_xdg_surface(c.wm_base, c.surface);
    xdg_surface_add_listener(c.xdg_surface, &xdg_surface_listener, &c);
    c.toplevel = xdg_surface_get_toplevel(c.xdg_surface);
    xdg_toplevel_add_listener(c.toplevel, &toplevel_listener, &c);
    xdg_toplevel_set_title(c.toplevel, "wlclient-test");

    /* Optional: request server-side decorations (PR14e). The compositor forces
     * SERVER_SIDE for tiling, which the client honors by drawing no titlebar. */
    if (getenv("WLC_DECOR") && c.decor_mgr) {
        struct zxdg_toplevel_decoration_v1 *deco =
            zxdg_decoration_manager_v1_get_toplevel_decoration(c.decor_mgr,
                                                               c.toplevel);
        zxdg_toplevel_decoration_v1_add_listener(deco, &decor_listener, &c);
        zxdg_toplevel_decoration_v1_set_mode(
            deco, ZXDG_TOPLEVEL_DECORATION_V1_MODE_SERVER_SIDE);
    }

    wl_surface_commit(c.surface);

    /* Wait for the initial configure before attaching a buffer. */
    while (!c.configured)
        if (wl_display_dispatch(display) < 0) { fprintf(stderr, "dispatch\n"); return 1; }
    printf("CONFIGURED\n");
    fflush(stdout);

    struct wl_buffer *buffer = make_buffer(&c);
    if (!buffer) return 1;

    wl_surface_attach(c.surface, buffer, 0, 0);
    wl_surface_damage(c.surface, 0, 0, WIN_W, WIN_H);
    struct wl_callback *frame = wl_surface_frame(c.surface);
    wl_callback_add_listener(frame, &frame_listener, &c);
    wl_surface_commit(c.surface);

    /* The frame callback fires once the compositor has flipped our pixels. */
    while (!c.frame_done)
        if (wl_display_dispatch(display) < 0) { fprintf(stderr, "dispatch\n"); return 1; }
    printf("CLIENT_MAPPED\n");
    printf("CLIENT_READY\n");   /* signal to the test to inject input */
    fflush(stdout);

    /* Receive one host-injected key and one pointer button, forwarded by
     * the compositor from libinput. */
    while (!(c.got_key && c.got_button))
        if (wl_display_dispatch(display) < 0) { fprintf(stderr, "dispatch\n"); return 1; }

    if (!c.got_keymap) {
        fprintf(stderr, "never received a valid xkb keymap\n");
        return 1;
    }
    printf("CLIENT_OK key=%u btn=%u\n", c.key_code, c.btn_code);
    fflush(stdout);

    wl_display_disconnect(display);
    return 0;
}
