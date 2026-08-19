/* libkwl implementation — see include/kwl.h.
 *
 * One translation unit (the plan's window.c/buffer.c/input.c split is not
 * load-bearing; a single TU keeps the inline build in build-programs.sh
 * trivial). Generalizes programs/wlcompositor/wlclient-test.c:
 *
 *   - connect + registry bind (wl_compositor, wl_shm, xdg_wm_base,
 *     wl_seat, wl_output)
 *   - an xdg_toplevel, configure/ack, wm_base ping/pong
 *   - DOUBLE-buffered wl_shm: two gbm renderD128 bos, each mapped to a
 *     persistent CPU pointer and shared to the compositor via a prime-fd
 *     pool; commits alternate between them
 *   - xkb keymap compile on wl_keyboard.keymap → keysym + UTF-8
 *   - pointer enter/motion/button
 * events land in a fixed ring the app pops via kwl_dispatch().
 *
 * Client-side decoration (CSD): every window carries a KWL_TITLEBAR_H-px
 * titlebar libkwl draws once into each buffer — title text plus a close
 * box. The buffer the compositor sees is (w × h+titlebar); the app's
 * kwl_window_surface() is a sub-view starting below the titlebar, and all
 * pointer events the app receives are content-local. A press on the
 * titlebar is not forwarded: it either emits KWL_CLOSE (on the close box)
 * or asks the compositor to start an interactive move via
 * xdg_toplevel.move — the standard Wayland CSD drag contract. */
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <wayland-client.h>
#include <wayland-client-protocol.h>
#include "xdg-shell-client-protocol.h"

#include <gbm.h>
#include <xkbcommon/xkbcommon.h>
#include <xkbcommon/xkbcommon-names.h>

#include <kwl.h>
#include <wpkdraw/wpkfont.h>

#define KWL_SOCKET_PATH "/tmp/wayland-0"
#define KWL_NUM_BUFFERS 2
#define KWL_EVQ_SIZE    64

/* CSD titlebar geometry (surface pixels). */
#define KWL_TB_FONT_PX  14
#define KWL_TB_CLOSE_SZ 16
#define KWL_TB_CLOSE_MARGIN 8

struct kwl_buffer {
    struct gbm_bo *bo;
    struct wl_buffer *wl_buf;
    uint32_t *pixels;   /* persistent CPU mapping of the shared bytes */
    void *map_data;     /* gbm_bo_map cookie, released at destroy */
    int stride;         /* bytes per row */
};

struct kwl_window {
    struct wl_display *display;
    struct wl_registry *registry;
    struct wl_compositor *compositor;
    struct wl_shm *shm;
    struct xdg_wm_base *wm_base;
    struct wl_seat *seat;
    struct wl_output *output;

    struct wl_surface *surface;
    struct xdg_surface *xdg_surface;
    struct xdg_toplevel *toplevel;
    struct wl_keyboard *keyboard;
    struct wl_pointer *pointer;

    int w, h;        /* app-visible CONTENT size */
    int total_h;     /* h + KWL_TITLEBAR_H — the wl_surface size */
    int configured;

    /* gbm allocation for the shared wl_shm buffers. */
    int render_fd;
    struct gbm_device *gbm;
    struct kwl_buffer bufs[KWL_NUM_BUFFERS];
    int back_index;
    struct wpk_surface back;   /* stable handle re-pointed on each swap */

    /* xkb keyboard state. */
    struct xkb_context *xkb_ctx;
    struct xkb_keymap *xkb_keymap;
    struct xkb_state *xkb_state;
    uint32_t mods;

    /* pointer position (surface-local, i.e. including the titlebar). */
    int ptr_x, ptr_y;

    /* event ring: push at tail, pop at head; overflow drops the newest. */
    struct kwl_event evq[KWL_EVQ_SIZE];
    int evq_head, evq_tail, evq_count;
};

/* ---- event ring -------------------------------------------------------- */

static void kwl_push(struct kwl_window *w, const struct kwl_event *e) {
    if (w->evq_count >= KWL_EVQ_SIZE) return;   /* drop newest (v1) */
    w->evq[w->evq_tail] = *e;
    w->evq_tail = (w->evq_tail + 1) % KWL_EVQ_SIZE;
    w->evq_count++;
}

static int kwl_pop(struct kwl_window *w, struct kwl_event *out) {
    if (w->evq_count == 0) return 0;
    *out = w->evq[w->evq_head];
    w->evq_head = (w->evq_head + 1) % KWL_EVQ_SIZE;
    w->evq_count--;
    return 1;
}

/* ---- registry ---------------------------------------------------------- */

static void registry_global(void *data, struct wl_registry *reg, uint32_t name,
                            const char *iface, uint32_t version) {
    struct kwl_window *w = data;
    if (strcmp(iface, "wl_compositor") == 0)
        w->compositor = wl_registry_bind(reg, name, &wl_compositor_interface,
                                         version < 4 ? version : 4);
    else if (strcmp(iface, "wl_shm") == 0)
        w->shm = wl_registry_bind(reg, name, &wl_shm_interface, 1);
    else if (strcmp(iface, "xdg_wm_base") == 0)
        w->wm_base = wl_registry_bind(reg, name, &xdg_wm_base_interface, 1);
    else if (strcmp(iface, "wl_seat") == 0)
        w->seat = wl_registry_bind(reg, name, &wl_seat_interface, 1);
    else if (strcmp(iface, "wl_output") == 0)
        w->output = wl_registry_bind(reg, name, &wl_output_interface, 2);
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
    struct kwl_window *w = data;
    xdg_surface_ack_configure(xs, serial);
    w->configured = 1;
}
static const struct xdg_surface_listener xdg_surface_listener = {
    .configure = xdg_surface_configure,
};

/* v1 ignores the compositor's suggested size — the window keeps the size
 * the app requested (surfaces are fixed-size in v1). */
static void toplevel_configure(void *data, struct xdg_toplevel *t, int32_t w,
                               int32_t h, struct wl_array *states) {}
static void toplevel_close(void *data, struct xdg_toplevel *t) {
    struct kwl_window *win = data;
    struct kwl_event e = { .type = KWL_CLOSE };
    kwl_push(win, &e);
}
static const struct xdg_toplevel_listener toplevel_listener = {
    .configure = toplevel_configure,
    .close = toplevel_close,
};

/* ---- frame callback ---------------------------------------------------- */

static void frame_done(void *data, struct wl_callback *cb, uint32_t t) {
    struct kwl_window *win = data;
    struct kwl_event e = { .type = KWL_FRAME };
    kwl_push(win, &e);
    wl_callback_destroy(cb);
}
static const struct wl_callback_listener frame_listener = {
    .done = frame_done,
};

/* ---- keyboard ---------------------------------------------------------- */

static uint32_t kwl_recompute_mods(struct kwl_window *w) {
    uint32_t m = 0;
    if (!w->xkb_state) return 0;
    if (xkb_state_mod_name_is_active(w->xkb_state, XKB_MOD_NAME_SHIFT,
                                     XKB_STATE_MODS_EFFECTIVE) > 0)
        m |= KWL_MOD_SHIFT;
    if (xkb_state_mod_name_is_active(w->xkb_state, XKB_MOD_NAME_CTRL,
                                     XKB_STATE_MODS_EFFECTIVE) > 0)
        m |= KWL_MOD_CTRL;
    if (xkb_state_mod_name_is_active(w->xkb_state, XKB_MOD_NAME_ALT,
                                     XKB_STATE_MODS_EFFECTIVE) > 0)
        m |= KWL_MOD_ALT;
    return m;
}

static void kbd_keymap(void *data, struct wl_keyboard *k, uint32_t format,
                       int32_t fd, uint32_t size) {
    struct kwl_window *w = data;
    if (format != WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1) { close(fd); return; }
    char *map = mmap(NULL, size, PROT_READ, MAP_PRIVATE, fd, 0);
    if (map == MAP_FAILED) { close(fd); return; }

    /* Compile from the keymap string only — no rules/names lookup — so skip
     * the default include-path setup (which has no valid path in the wasm
     * sysroot and makes xkb_context_new fail here). Matches wlcompositor.c
     * and xkb_smoke.c. */
    if (!w->xkb_ctx)
        w->xkb_ctx = xkb_context_new(XKB_CONTEXT_NO_DEFAULT_INCLUDES);
    if (w->xkb_ctx) {
        struct xkb_keymap *km = xkb_keymap_new_from_string(
            w->xkb_ctx, map, XKB_KEYMAP_FORMAT_TEXT_V1,
            XKB_KEYMAP_COMPILE_NO_FLAGS);
        if (km) {
            struct xkb_state *st = xkb_state_new(km);
            if (st) {
                if (w->xkb_state) xkb_state_unref(w->xkb_state);
                if (w->xkb_keymap) xkb_keymap_unref(w->xkb_keymap);
                w->xkb_keymap = km;
                w->xkb_state = st;
            } else {
                xkb_keymap_unref(km);
            }
        }
    }
    munmap(map, size);
    close(fd);
}
static void kbd_enter(void *data, struct wl_keyboard *k, uint32_t serial,
                      struct wl_surface *surf, struct wl_array *keys) {}
static void kbd_leave(void *data, struct wl_keyboard *k, uint32_t serial,
                      struct wl_surface *surf) {}
static void kbd_key(void *data, struct wl_keyboard *k, uint32_t serial,
                    uint32_t time, uint32_t key, uint32_t state) {
    struct kwl_window *w = data;
    if (!w->xkb_state) return;
    /* evdev keycode → xkb keycode is a fixed +8 offset. */
    xkb_keycode_t kc = key + 8;
    xkb_keysym_t sym = xkb_state_key_get_one_sym(w->xkb_state, kc);

    struct kwl_event e = {
        .type = KWL_KEY,
        .keysym = sym,
        .mods = w->mods,
        .state = state,
    };
    kwl_push(w, &e);

    /* On press, also emit the committed UTF-8 text (if any). */
    if (state == WL_KEYBOARD_KEY_STATE_PRESSED) {
        struct kwl_event t = { .type = KWL_TEXT, .mods = w->mods };
        int n = xkb_state_key_get_utf8(w->xkb_state, kc, t.utf8, sizeof(t.utf8));
        if (n > 0) kwl_push(w, &t);
    }
}
static void kbd_modifiers(void *data, struct wl_keyboard *k, uint32_t serial,
                          uint32_t dep, uint32_t lat, uint32_t lock,
                          uint32_t group) {
    struct kwl_window *w = data;
    if (!w->xkb_state) return;
    xkb_state_update_mask(w->xkb_state, dep, lat, lock, 0, 0, group);
    w->mods = kwl_recompute_mods(w);
}
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

/* The close box rect, in surface coordinates. */
static int in_close_box(struct kwl_window *w, int x, int y) {
    int bx = w->w - KWL_TB_CLOSE_MARGIN - KWL_TB_CLOSE_SZ;
    int by = (KWL_TITLEBAR_H - KWL_TB_CLOSE_SZ) / 2;
    return x >= bx && x < bx + KWL_TB_CLOSE_SZ &&
           y >= by && y < by + KWL_TB_CLOSE_SZ;
}

static void ptr_enter(void *data, struct wl_pointer *p, uint32_t serial,
                      struct wl_surface *surf, wl_fixed_t x, wl_fixed_t y) {
    struct kwl_window *w = data;
    w->ptr_x = wl_fixed_to_int(x);
    w->ptr_y = wl_fixed_to_int(y);
}
static void ptr_leave(void *data, struct wl_pointer *p, uint32_t serial,
                      struct wl_surface *surf) {}
static void ptr_motion(void *data, struct wl_pointer *p, uint32_t time,
                       wl_fixed_t x, wl_fixed_t y) {
    struct kwl_window *w = data;
    w->ptr_x = wl_fixed_to_int(x);
    w->ptr_y = wl_fixed_to_int(y);
    if (w->ptr_y < KWL_TITLEBAR_H) return;   /* decoration, not app content */
    struct kwl_event e = {
        .type = KWL_POINTER_MOTION,
        .x = w->ptr_x,
        .y = w->ptr_y - KWL_TITLEBAR_H,
    };
    kwl_push(w, &e);
}
static void ptr_button(void *data, struct wl_pointer *p, uint32_t serial,
                       uint32_t time, uint32_t button, uint32_t state) {
    struct kwl_window *w = data;
    if (w->ptr_y < KWL_TITLEBAR_H) {
        /* Titlebar interactions are the toolkit's, not the app's. */
        if (state != WL_POINTER_BUTTON_STATE_PRESSED) return;
        if (in_close_box(w, w->ptr_x, w->ptr_y)) {
            struct kwl_event e = { .type = KWL_CLOSE };
            kwl_push(w, &e);
        } else if (w->toplevel && w->seat) {
            /* CSD drag: hand the interaction to the compositor. It keeps
             * the pointer for the duration of the move grab. */
            xdg_toplevel_move(w->toplevel, w->seat, serial);
            wl_display_flush(w->display);
        }
        return;
    }
    struct kwl_event e = {
        .type = KWL_POINTER_BUTTON,
        .button = button,
        .state = state,
        .x = w->ptr_x,
        .y = w->ptr_y - KWL_TITLEBAR_H,
    };
    kwl_push(w, &e);
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

/* ---- connection helpers ------------------------------------------------ */

static int connect_socket(void) {
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) return -1;
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, KWL_SOCKET_PATH, sizeof(addr.sun_path) - 1);
    /* Retry to tolerate compositor/app spawn ordering. */
    for (int i = 0; i < 100; i++) {
        if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) == 0)
            return fd;
        usleep(10000);
    }
    close(fd);
    return -1;
}

/* Allocate one renderD128 bo, keep it CPU-mapped for the window's life, and
 * share it to the compositor as a wl_shm buffer backed by its prime-fd —
 * the gbm_bo_import path the compositor understands (see wlclient-test.c).
 * The bo covers the full surface: titlebar + content. */
static int kwl_buffer_init(struct kwl_window *w, struct kwl_buffer *b) {
    struct gbm_bo *bo = gbm_bo_create(w->gbm, w->w, w->total_h,
                                      GBM_FORMAT_XRGB8888,
                                      GBM_BO_USE_LINEAR | GBM_BO_USE_SCANOUT);
    if (!bo) return -1;

    uint32_t stride = 0;
    void *map_data = NULL;
    uint32_t *px =
        gbm_bo_map(bo, 0, 0, w->w, w->total_h, 0, &stride, &map_data);
    if (!px) { gbm_bo_destroy(bo); return -1; }

    int prime = gbm_bo_get_fd(bo);
    if (prime < 0) { gbm_bo_unmap(bo, map_data); gbm_bo_destroy(bo); return -1; }

    struct wl_shm_pool *pool =
        wl_shm_create_pool(w->shm, prime, (int32_t)(stride * w->total_h));
    struct wl_buffer *wl_buf = wl_shm_pool_create_buffer(
        pool, 0, w->w, w->total_h, (int32_t)stride, WL_SHM_FORMAT_XRGB8888);
    wl_shm_pool_destroy(pool);   /* the buffer keeps the pool alive */
    close(prime);                /* wl_shm dup'd it into the pool */

    b->bo = bo;
    b->wl_buf = wl_buf;
    b->pixels = px;
    b->map_data = map_data;
    b->stride = (int)stride;
    return 0;
}

/* The app's drawable: the buffer rows below the titlebar. */
static struct wpk_surface content_view(struct kwl_window *w,
                                       struct kwl_buffer *b) {
    return wpk_surface_wrap(
        b->pixels + (size_t)KWL_TITLEBAR_H * (b->stride / 4), w->w, w->h,
        b->stride);
}

/* Draw the CSD titlebar into one buffer. Called once per buffer at window
 * creation; the app never touches those rows, so no redraws are needed. */
static void draw_titlebar(struct kwl_window *w, struct kwl_buffer *b,
                          const char *title, struct wpk_font *font) {
    struct wpk_surface bar =
        wpk_surface_wrap(b->pixels, w->w, KWL_TITLEBAR_H, b->stride);
    wpk_clear(&bar, WPK_RGB(0x2a, 0x30, 0x40));
    /* 1px seam between titlebar and content. */
    wpk_rect(&bar, 0, KWL_TITLEBAR_H - 1, w->w, 1, WPK_RGB(0x1c, 0x20, 0x2c));

    if (font && title) {
        int baseline =
            (KWL_TITLEBAR_H + wpk_font_ascent_px(font)) / 2 - 1;
        wpk_text(&bar, font, 10, baseline, title, WPK_RGB(0xd8, 0xdd, 0xe8));
    }

    /* Close box: a subtle plate with an X. */
    int bx = w->w - KWL_TB_CLOSE_MARGIN - KWL_TB_CLOSE_SZ;
    int by = (KWL_TITLEBAR_H - KWL_TB_CLOSE_SZ) / 2;
    wpk_rect(&bar, bx, by, KWL_TB_CLOSE_SZ, KWL_TB_CLOSE_SZ,
             WPK_RGB(0x3d, 0x34, 0x3c));
    for (int i = 4; i < KWL_TB_CLOSE_SZ - 4; i++) {
        wpk_pixel(&bar, bx + i, by + i, WPK_RGB(0xe8, 0xb0, 0xb8));
        wpk_pixel(&bar, bx + KWL_TB_CLOSE_SZ - 1 - i, by + i,
                  WPK_RGB(0xe8, 0xb0, 0xb8));
    }
}

/* ---- public API -------------------------------------------------------- */

struct kwl_window *kwl_window_create(const char *title, int w, int h) {
    if (w <= 0 || h <= 0) { errno = EINVAL; return NULL; }
    struct kwl_window *win = calloc(1, sizeof(*win));
    if (!win) { errno = ENOMEM; return NULL; }
    win->w = w;
    win->h = h;
    win->total_h = h + KWL_TITLEBAR_H;

    int fd = connect_socket();
    if (fd < 0) goto fail;
    win->display = wl_display_connect_to_fd(fd);
    if (!win->display) { close(fd); goto fail; }

    win->registry = wl_display_get_registry(win->display);
    wl_registry_add_listener(win->registry, &registry_listener, win);
    wl_display_roundtrip(win->display);   /* receive globals */
    wl_display_roundtrip(win->display);   /* receive their initial events */

    if (!win->compositor || !win->shm || !win->wm_base || !win->seat)
        goto fail;

    xdg_wm_base_add_listener(win->wm_base, &wm_base_listener, win);

    /* Seat inputs first, so the compositor's map-time focus reaches them. */
    win->keyboard = wl_seat_get_keyboard(win->seat);
    if (win->keyboard)
        wl_keyboard_add_listener(win->keyboard, &keyboard_listener, win);
    win->pointer = wl_seat_get_pointer(win->seat);
    if (win->pointer)
        wl_pointer_add_listener(win->pointer, &pointer_listener, win);

    /* Toplevel. */
    win->surface = wl_compositor_create_surface(win->compositor);
    win->xdg_surface = xdg_wm_base_get_xdg_surface(win->wm_base, win->surface);
    xdg_surface_add_listener(win->xdg_surface, &xdg_surface_listener, win);
    win->toplevel = xdg_surface_get_toplevel(win->xdg_surface);
    xdg_toplevel_add_listener(win->toplevel, &toplevel_listener, win);
    if (title) {
        xdg_toplevel_set_title(win->toplevel, title);
        /* The compositor's placement rules key on app_id. */
        xdg_toplevel_set_app_id(win->toplevel, title);
    }
    wl_surface_commit(win->surface);

    /* Wait for the initial configure before attaching a buffer. */
    while (!win->configured)
        if (wl_display_dispatch(win->display) < 0) goto fail;

    /* gbm-backed double buffer. */
    win->render_fd = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC);
    if (win->render_fd < 0) goto fail;
    win->gbm = gbm_create_device(win->render_fd);
    if (!win->gbm) goto fail;
    for (int i = 0; i < KWL_NUM_BUFFERS; i++)
        if (kwl_buffer_init(win, &win->bufs[i]) != 0) goto fail;

    /* Decorate both buffers once; the app only ever draws the content. */
    struct wpk_font *tb_font = wpk_font_load_default(KWL_TB_FONT_PX);
    for (int i = 0; i < KWL_NUM_BUFFERS; i++)
        draw_titlebar(win, &win->bufs[i], title, tb_font);
    if (tb_font) wpk_font_destroy(tb_font);

    win->back_index = 0;
    win->back = content_view(win, &win->bufs[0]);
    return win;

fail:
    kwl_window_destroy(win);
    return NULL;
}

void kwl_window_destroy(struct kwl_window *win) {
    if (!win) return;
    for (int i = 0; i < KWL_NUM_BUFFERS; i++) {
        struct kwl_buffer *b = &win->bufs[i];
        if (b->wl_buf) wl_buffer_destroy(b->wl_buf);
        if (b->bo) {
            if (b->map_data) gbm_bo_unmap(b->bo, b->map_data);
            gbm_bo_destroy(b->bo);
        }
    }
    if (win->gbm) gbm_device_destroy(win->gbm);
    if (win->render_fd > 0) close(win->render_fd);
    if (win->xkb_state) xkb_state_unref(win->xkb_state);
    if (win->xkb_keymap) xkb_keymap_unref(win->xkb_keymap);
    if (win->xkb_ctx) xkb_context_unref(win->xkb_ctx);
    if (win->toplevel) xdg_toplevel_destroy(win->toplevel);
    if (win->xdg_surface) xdg_surface_destroy(win->xdg_surface);
    if (win->surface) wl_surface_destroy(win->surface);
    if (win->display) wl_display_disconnect(win->display);
    free(win);
}

struct wpk_surface *kwl_window_surface(struct kwl_window *win) {
    return &win->back;
}

void kwl_window_commit(struct kwl_window *win) {
    struct kwl_buffer *b = &win->bufs[win->back_index];
    wl_surface_attach(win->surface, b->wl_buf, 0, 0);
    wl_surface_damage(win->surface, 0, 0, win->w, win->total_h);
    struct wl_callback *cb = wl_surface_frame(win->surface);
    wl_callback_add_listener(cb, &frame_listener, win);
    wl_surface_commit(win->surface);

    /* Swap to the other buffer for the next frame. With 2 buffers + frame
     * pacing the alternate has always been presented by then. */
    int next = (win->back_index + 1) % KWL_NUM_BUFFERS;
    win->back_index = next;
    win->back = content_view(win, &win->bufs[next]);
}

int kwl_dispatch(struct kwl_window *win, struct kwl_event *out, int timeout_ms) {
    if (kwl_pop(win, out)) return 1;

    /* Process anything already queued without touching the socket. */
    wl_display_dispatch_pending(win->display);
    if (kwl_pop(win, out)) return 1;

    wl_display_flush(win->display);

    struct pollfd pfd = {
        .fd = wl_display_get_fd(win->display),
        .events = POLLIN,
    };
    int pr = poll(&pfd, 1, timeout_ms);
    if (pr > 0 && (pfd.revents & POLLIN)) {
        /* Data is ready, so this read+dispatch won't block. */
        wl_display_dispatch(win->display);
    }
    if (kwl_pop(win, out)) return 1;
    return 0;
}

int kwl_display_fd(struct kwl_window *win) {
    return wl_display_get_fd(win->display);
}
