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
 *   4. attach + commit + request a frame callback and a wp_presentation
 *      feedback; when they fire, the compositor has flipped our pixels
 *      onto card0 and reported the flip's CLOCK_MONOTONIC timestamp.
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
#include "presentation-time-client-protocol.h"
#include "xdg-output-v1-client-protocol.h"
#include "viewporter-client-protocol.h"
#include "fractional-scale-v1-client-protocol.h"

#include <xkbcommon/xkbcommon.h>

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
    struct wp_presentation *presentation;
    struct zxdg_output_manager_v1 *xdg_output_mgr;
    struct wp_viewporter *viewporter;
    struct wp_fractional_scale_manager_v1 *fractional_scale_mgr;

    struct wl_surface *surface;
    struct xdg_surface *xdg_surface;
    struct xdg_toplevel *toplevel;

    int configured;     /* got + acked the initial xdg configure */
    int frame_done;     /* compositor flipped our buffer */
    int presented;      /* wp_presentation_feedback resolved (either event) */
    int got_keymap;     /* wl_keyboard.keymap arrived + parsed */
    int got_key;        /* wl_keyboard.key arrived */
    uint32_t key_code, key_state;
    int got_button;     /* wl_pointer.button arrived */
    uint32_t btn_code, btn_state;
    int closed;         /* compositor sent xdg_toplevel.close (killactive) */
    int32_t output_scale;   /* wl_output.scale */
    int32_t entered_scale;  /* the scale of the output wl_surface.enter named,
                             * 0 until the enter arrives */
};

/* ---- wp_presentation --------------------------------------------------- */

static void presentation_clock_id(void *data, struct wp_presentation *p,
                                  uint32_t clk_id) {
    printf("PRESENTATION_CLOCK id=%u\n", clk_id);
    fflush(stdout);
}
static const struct wp_presentation_listener presentation_listener = {
    .clock_id = presentation_clock_id,
};

/* ---- wl_output v4 ------------------------------------------------------ */

static void output_geometry(void *data, struct wl_output *o, int32_t x,
                            int32_t y, int32_t phys_w, int32_t phys_h,
                            int32_t subpixel, const char *make,
                            const char *model, int32_t transform) {}
static void output_mode(void *data, struct wl_output *o, uint32_t flags,
                        int32_t w, int32_t h, int32_t refresh) {
    printf("OUTPUT_MODE w=%d h=%d\n", w, h);
    fflush(stdout);
}
static void output_done(void *data, struct wl_output *o) {}
static void output_scale(void *data, struct wl_output *o, int32_t factor) {
    struct client *c = data;
    c->output_scale = factor;
    printf("OUTPUT_SCALE factor=%d\n", factor);
    fflush(stdout);
}
static void output_name(void *data, struct wl_output *o, const char *name) {
    printf("OUTPUT_NAME %s\n", name);
    fflush(stdout);
}
static void output_description(void *data, struct wl_output *o,
                               const char *description) {}
static const struct wl_output_listener output_listener = {
    .geometry = output_geometry,
    .mode = output_mode,
    .done = output_done,
    .scale = output_scale,
    .name = output_name,
    .description = output_description,
};

/* ---- wl_surface -------------------------------------------------------- */

/* The output a surface sits on, and with it the scale to render at. A client
 * that reads its scale here (mako does) must have the event before it draws
 * its first frame, so the compositor sends it when the surface takes a role. */
static void surface_enter(void *data, struct wl_surface *s,
                          struct wl_output *o) {
    struct client *c = data;
    c->entered_scale = c->output_scale;
    printf("SURFACE_ENTER scale=%d\n", c->entered_scale);
    fflush(stdout);
}
static void surface_leave(void *data, struct wl_surface *s,
                          struct wl_output *o) {}
static const struct wl_surface_listener surface_listener = {
    .enter = surface_enter,
    .leave = surface_leave,
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
    else if (strcmp(iface, "wl_output") == 0) {
        c->output = wl_registry_bind(reg, name, &wl_output_interface,
                                     version < 4 ? version : 4);
        wl_output_add_listener(c->output, &output_listener, c);
    }
    else if (strcmp(iface, "zxdg_decoration_manager_v1") == 0)
        c->decor_mgr = wl_registry_bind(
            reg, name, &zxdg_decoration_manager_v1_interface, 1);
    else if (strcmp(iface, "wp_presentation") == 0) {
        c->presentation =
            wl_registry_bind(reg, name, &wp_presentation_interface, 1);
        /* clock_id arrives on the bind roundtrip — listen from the start. */
        wp_presentation_add_listener(c->presentation, &presentation_listener,
                                     c);
    } else if (strcmp(iface, "zxdg_output_manager_v1") == 0)
        c->xdg_output_mgr = wl_registry_bind(
            reg, name, &zxdg_output_manager_v1_interface,
            version < 3 ? version : 3);
    else if (strcmp(iface, "wp_viewporter") == 0)
        c->viewporter =
            wl_registry_bind(reg, name, &wp_viewporter_interface, 1);
    else if (strcmp(iface, "wp_fractional_scale_manager_v1") == 0)
        c->fractional_scale_mgr = wl_registry_bind(
            reg, name, &wp_fractional_scale_manager_v1_interface, 1);
}

/* ---- xdg-output / fractional-scale ------------------------------------- */

static void xdg_output_logical_position(void *data, struct zxdg_output_v1 *xo,
                                        int32_t x, int32_t y) {
    printf("XDG_OUTPUT_POS x=%d y=%d\n", x, y);
    fflush(stdout);
}
static void xdg_output_logical_size(void *data, struct zxdg_output_v1 *xo,
                                    int32_t w, int32_t h) {
    printf("XDG_OUTPUT_SIZE w=%d h=%d\n", w, h);
    fflush(stdout);
}
static void xdg_output_done(void *data, struct zxdg_output_v1 *xo) {}
static void xdg_output_name(void *data, struct zxdg_output_v1 *xo,
                            const char *name) {
    printf("XDG_OUTPUT_NAME %s\n", name);
    fflush(stdout);
}
static void xdg_output_description(void *data, struct zxdg_output_v1 *xo,
                                   const char *description) {}
static const struct zxdg_output_v1_listener xdg_output_listener = {
    .logical_position = xdg_output_logical_position,
    .logical_size = xdg_output_logical_size,
    .done = xdg_output_done,
    .name = xdg_output_name,
    .description = xdg_output_description,
};

static void fractional_scale_preferred(void *data,
                                       struct wp_fractional_scale_v1 *fs,
                                       uint32_t scale) {
    printf("FRACTIONAL_SCALE scale=%u\n", scale);
    fflush(stdout);
}
static const struct wp_fractional_scale_v1_listener fractional_scale_listener = {
    .preferred_scale = fractional_scale_preferred,
};

static void feedback_sync_output(void *data,
                                 struct wp_presentation_feedback *fb,
                                 struct wl_output *output) {}
static void feedback_presented(void *data, struct wp_presentation_feedback *fb,
                               uint32_t sec_hi, uint32_t sec_lo, uint32_t nsec,
                               uint32_t refresh, uint32_t seq_hi,
                               uint32_t seq_lo, uint32_t flags) {
    struct client *c = data;
    c->presented = 1;
    printf("PRESENTED sec=%u nsec=%u refresh=%u seq=%u flags=0x%x\n",
           sec_lo, nsec, refresh, seq_lo, flags);
    fflush(stdout);
    wp_presentation_feedback_destroy(fb);
}
static void feedback_discarded(void *data,
                               struct wp_presentation_feedback *fb) {
    struct client *c = data;
    c->presented = 1;
    printf("PRESENTATION_DISCARDED\n");
    fflush(stdout);
    wp_presentation_feedback_destroy(fb);
}
static const struct wp_presentation_feedback_listener feedback_listener = {
    .sync_output = feedback_sync_output,
    .presented = feedback_presented,
    .discarded = feedback_discarded,
};

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
static void toplevel_close(void *data, struct xdg_toplevel *t) {
    ((struct client *)data)->closed = 1;
}
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
     * we compile it exactly as a real client would and probe keys a
     * terminal needs beyond the letters (F1, Delete). */
    char *map = mmap(NULL, size, PROT_READ, MAP_PRIVATE, fd, 0);
    if (map != MAP_FAILED) {
        if (format == WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1 &&
            strncmp(map, "xkb_keymap", 10) == 0) {
            struct xkb_context *ctx =
                xkb_context_new(XKB_CONTEXT_NO_DEFAULT_INCLUDES);
            /* The compositor's map is NUL-terminated (size = strlen + 1),
             * which is what from_string expects. */
            struct xkb_keymap *km = ctx
                ? xkb_keymap_new_from_string(ctx, map,
                                             XKB_KEYMAP_FORMAT_TEXT_V1,
                                             XKB_KEYMAP_COMPILE_NO_FLAGS)
                : NULL;
            if (km) {
                /* evdev KEY_F1 (59) + 8, KEY_DELETE (111) + 8. */
                const xkb_keysym_t *syms;
                int f1 = xkb_keymap_key_get_syms_by_level(km, 67, 0, 0,
                                                          &syms) == 1 &&
                         syms[0] == XKB_KEY_F1;
                int del = xkb_keymap_key_get_syms_by_level(km, 119, 0, 0,
                                                           &syms) == 1 &&
                          syms[0] == XKB_KEY_Delete;
                c->got_keymap = f1 && del;
                printf("KEYMAP_SYMS f1=%d delete=%d\n", f1, del);
                xkb_keymap_unref(km);
            }
            if (ctx) xkb_context_unref(ctx);
        }
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
    wl_surface_add_listener(c.surface, &surface_listener, &c);
    c.xdg_surface = xdg_wm_base_get_xdg_surface(c.wm_base, c.surface);
    xdg_surface_add_listener(c.xdg_surface, &xdg_surface_listener, &c);
    c.toplevel = xdg_surface_get_toplevel(c.xdg_surface);
    xdg_toplevel_add_listener(c.toplevel, &toplevel_listener, &c);
    xdg_toplevel_set_title(c.toplevel, "wlclient-test");
    /* The app_id is what names this client in the compositor's markers. */
    xdg_toplevel_set_app_id(c.toplevel, "wlclient-test");

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

    /* Optional (PR24): exercise the logical-output + crop/scale globals. The
     * xdg_output burst and the preferred scale arrive on the roundtrip; the
     * viewport doubles the mapped size, which the compositor's VIEWPORT
     * marker reports at commit. */
    if (getenv("WLC_PROTOS")) {
        if (!c.xdg_output_mgr || !c.viewporter || !c.fractional_scale_mgr) {
            fprintf(stderr, "missing protocol globals: xdg_out=%p vp=%p frac=%p\n",
                    (void *)c.xdg_output_mgr, (void *)c.viewporter,
                    (void *)c.fractional_scale_mgr);
            return 1;
        }
        struct zxdg_output_v1 *xo =
            zxdg_output_manager_v1_get_xdg_output(c.xdg_output_mgr, c.output);
        zxdg_output_v1_add_listener(xo, &xdg_output_listener, &c);
        struct wp_fractional_scale_v1 *fs =
            wp_fractional_scale_manager_v1_get_fractional_scale(
                c.fractional_scale_mgr, c.surface);
        wp_fractional_scale_v1_add_listener(fs, &fractional_scale_listener, &c);
        struct wp_viewport *vp =
            wp_viewporter_get_viewport(c.viewporter, c.surface);
        wp_viewport_set_destination(vp, WIN_W * 2, WIN_H * 2);
        wl_display_roundtrip(display);
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
    /* Optional: declare the buffer as scale-N pixels, so the same WIN_W x WIN_H
     * bytes cover a window N times smaller. WIN_W and WIN_H are even, which
     * scale 2 requires. */
    int buf_scale = 1;
    const char *want_buf_scale = getenv("WLC_BUFSCALE");
    /* Or take it from wl_surface.enter, the way mako does. The enter has to
     * have arrived by now: this is the first frame, and one frame is all a
     * toast lives for — render it at the wrong scale and it is soft for good. */
    if (getenv("WLC_ENTERSCALE")) {
        if (!c.entered_scale) {
            fprintf(stderr, "no wl_surface.enter before the first frame\n");
            return 1;
        }
        buf_scale = c.entered_scale;
        wl_surface_set_buffer_scale(c.surface, buf_scale);
    } else if (want_buf_scale) {
        buf_scale = atoi(want_buf_scale);
        wl_surface_set_buffer_scale(c.surface, buf_scale);
    }
    wl_surface_damage(c.surface, 0, 0, WIN_W / buf_scale, WIN_H / buf_scale);
    struct wl_callback *frame = wl_surface_frame(c.surface);
    wl_callback_add_listener(frame, &frame_listener, &c);
    if (c.presentation) {
        struct wp_presentation_feedback *fb =
            wp_presentation_feedback(c.presentation, c.surface);
        wp_presentation_feedback_add_listener(fb, &feedback_listener, &c);
    }
    wl_surface_commit(c.surface);

    /* The frame callback fires once the compositor has flipped our pixels;
     * the presentation feedback resolves on the same flip. */
    while (!c.frame_done || (c.presentation && !c.presented))
        if (wl_display_dispatch(display) < 0) { fprintf(stderr, "dispatch\n"); return 1; }
    printf("CLIENT_MAPPED\n");
    printf("CLIENT_READY\n");   /* signal to the test to inject input */
    fflush(stdout);

    /* Receive one host-injected key and one pointer button, forwarded by
     * the compositor from libinput — or exit if the compositor closes us
     * (SUPER+W killactive). */
    while (!(c.got_key && c.got_button) && !c.closed)
        if (wl_display_dispatch(display) < 0) { fprintf(stderr, "dispatch\n"); return 1; }

    if (c.closed) {
        printf("CLIENT_CLOSED\n");
        fflush(stdout);
        wl_display_disconnect(display);
        return 0;
    }

    if (!c.got_keymap) {
        fprintf(stderr, "never received a valid xkb keymap\n");
        return 1;
    }
    printf("CLIENT_OK key=%u btn=%u\n", c.key_code, c.btn_code);
    fflush(stdout);

    wl_display_disconnect(display);
    return 0;
}
