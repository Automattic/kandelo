/*
 * wlclip-test — the clipboard gate's Wayland client. A raw
 * libwayland-client program that drives wlcompositor's selection so
 * host/test/wlcompositor-clipboard-smoke.test.ts can assert real transfers.
 * One binary, several roles (argv[1]):
 *
 *   copy TEXT        map a window, and once it has keyboard focus set the
 *                    selection to TEXT through wl_data_device; serve every
 *                    wl_data_source.send; exit 0 on cancelled.
 *   paste            map a window; when a selection offer arrives, read it
 *                    through a pipe (wl_data_offer.receive) and print it;
 *                    exit 0 after the first non-empty paste.
 *   control-set TEXT set the selection through zwlr_data_control (no window,
 *                    no focus, no serial); serve sends; exit 0 on cancelled.
 *   keys [N]         map a window and print key events with the modifier
 *                    names in effect, so a sendshortcut chord is visible;
 *                    exit after N non-modifier key presses.
 *
 * `--app-id ID` (before the role) sets the window's xdg app_id, which is
 * what the compositor's windowrule tags match. Markers are prefixed CLIP_
 * and only ever print test text.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
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
#include "wlr-data-control-v1-client-protocol.h"

#include <xkbcommon/xkbcommon.h>

#include <gbm.h>

#define WL_SOCKET_PATH "/tmp/wayland-0"
#define WIN_W 160
#define WIN_H 120
#define MIME_UTF8 "text/plain;charset=utf-8"
#define MIME_TEXT "text/plain"
#define MAX_MIMES 16

struct offer_mimes {
    int n;
    char *mime[MAX_MIMES];
};

static struct {
    const char *role;
    const char *text;          /* copy / control-set payload */
    const char *app_id;
    int keys_wanted;

    struct wl_display *display;
    struct wl_compositor *compositor;
    struct wl_shm *shm;
    struct xdg_wm_base *wm_base;
    struct wl_seat *seat;
    struct wl_data_device_manager *ddm;
    struct zwlr_data_control_manager_v1 *dcm;

    struct wl_surface *surface;
    int configured;
    int focused;
    uint32_t enter_serial;
    int selection_set;
    int cancelled;
    int pasted;
    int keys_seen;

    struct xkb_context *xkb_ctx;
    struct xkb_keymap *keymap;
    uint32_t mods_depressed;
} c;

static void say(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void say(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
    putchar('\n');
    fflush(stdout);
}

/* ---- offers (shared by wl_data_offer and the data-control offer) ------- */

static void mimes_add(struct offer_mimes *m, const char *mime) {
    if (m->n < MAX_MIMES) m->mime[m->n++] = strdup(mime);
}
static void mimes_free(struct offer_mimes *m) {
    for (int i = 0; i < m->n; i++) free(m->mime[i]);
    free(m);
}
static const char *mimes_pick(const struct offer_mimes *m) {
    for (int i = 0; i < m->n; i++)
        if (!strcmp(m->mime[i], MIME_UTF8)) return MIME_UTF8;
    for (int i = 0; i < m->n; i++)
        if (!strcmp(m->mime[i], MIME_TEXT)) return MIME_TEXT;
    return NULL;
}

/* Read a pipe to EOF. The source writes and closes its end; EOF arrives
 * only once every write end is closed — ours, the compositor's forwarded
 * copy, and the source's — which is what this exercises. */
static char *read_to_eof(int fd, size_t *len) {
    size_t cap = 256, n = 0;
    char *buf = malloc(cap + 1);
    for (;;) {
        if (n == cap) buf = realloc(buf, (cap *= 2) + 1);
        ssize_t r = read(fd, buf + n, cap - n);
        if (r < 0 && errno == EINTR) continue;
        if (r <= 0) break;
        n += (size_t)r;
    }
    buf[n] = '\0';
    *len = n;
    return buf;
}

/* ---- wl_data_offer / wl_data_device ------------------------------------ */

static void doffer_offer(void *data, struct wl_data_offer *o, const char *mime) {
    mimes_add(data, mime);
}
static void doffer_source_actions(void *data, struct wl_data_offer *o,
                                  uint32_t a) {}
static void doffer_action(void *data, struct wl_data_offer *o, uint32_t a) {}
static const struct wl_data_offer_listener doffer_listener = {
    .offer = doffer_offer,
    .source_actions = doffer_source_actions,
    .action = doffer_action,
};

static void ddev_data_offer(void *data, struct wl_data_device *d,
                            struct wl_data_offer *offer) {
    wl_data_offer_add_listener(offer, &doffer_listener,
                               calloc(1, sizeof(struct offer_mimes)));
}
static void ddev_enter(void *data, struct wl_data_device *d, uint32_t serial,
                       struct wl_surface *s, wl_fixed_t x, wl_fixed_t y,
                       struct wl_data_offer *o) {}
static void ddev_leave(void *data, struct wl_data_device *d) {}
static void ddev_motion(void *data, struct wl_data_device *d, uint32_t t,
                        wl_fixed_t x, wl_fixed_t y) {}
static void ddev_drop(void *data, struct wl_data_device *d) {}
static void ddev_selection(void *data, struct wl_data_device *d,
                           struct wl_data_offer *offer) {
    if (!offer) {
        say("CLIP_SELECTION_EMPTY");
        return;
    }
    struct offer_mimes *m = wl_data_offer_get_user_data(offer);
    const char *mime = mimes_pick(m);
    say("CLIP_OFFER mimes=%d text=%s focused=%d", m->n, mime ? "yes" : "no",
        c.focused);
    if (mime && !strcmp(c.role, "paste") && !c.pasted) {
        int fds[2];
        if (pipe(fds) != 0) { perror("pipe"); exit(1); }
        wl_data_offer_receive(offer, mime, fds[1]);
        close(fds[1]);
        wl_display_flush(c.display);
        size_t len;
        char *text = read_to_eof(fds[0], &len);
        close(fds[0]);
        say("CLIP_PASTED len=%zu text=%s", len, text);
        c.pasted = len > 0;
        free(text);
    }
    mimes_free(m);
    wl_data_offer_destroy(offer);
}
static const struct wl_data_device_listener ddev_listener = {
    .data_offer = ddev_data_offer,
    .enter = ddev_enter,
    .leave = ddev_leave,
    .motion = ddev_motion,
    .drop = ddev_drop,
    .selection = ddev_selection,
};

/* ---- sources ----------------------------------------------------------- */

static void serve_send(const char *mime, int32_t fd) {
    size_t len = strlen(c.text);
    const char *p = c.text;
    while (len > 0) {
        ssize_t w = write(fd, p, len);
        if (w < 0 && errno == EINTR) continue;
        if (w <= 0) break;
        p += w;
        len -= (size_t)w;
    }
    close(fd);
    say("CLIP_SENT mime=%s", mime);
}

static void dsrc_target(void *data, struct wl_data_source *s, const char *m) {}
static void dsrc_send(void *data, struct wl_data_source *s, const char *mime,
                      int32_t fd) {
    serve_send(mime, fd);
}
static void dsrc_cancelled(void *data, struct wl_data_source *s) {
    say("CLIP_CANCELLED");
    c.cancelled = 1;
    wl_data_source_destroy(s);
}
static void dsrc_dnd_drop_performed(void *data, struct wl_data_source *s) {}
static void dsrc_dnd_finished(void *data, struct wl_data_source *s) {}
static void dsrc_action(void *data, struct wl_data_source *s, uint32_t a) {}
static const struct wl_data_source_listener dsrc_listener = {
    .target = dsrc_target,
    .send = dsrc_send,
    .cancelled = dsrc_cancelled,
    .dnd_drop_performed = dsrc_dnd_drop_performed,
    .dnd_finished = dsrc_dnd_finished,
    .action = dsrc_action,
};

static void csrc_send(void *data, struct zwlr_data_control_source_v1 *s,
                      const char *mime, int32_t fd) {
    serve_send(mime, fd);
}
static void csrc_cancelled(void *data, struct zwlr_data_control_source_v1 *s) {
    say("CLIP_CANCELLED");
    c.cancelled = 1;
    zwlr_data_control_source_v1_destroy(s);
}
static const struct zwlr_data_control_source_v1_listener csrc_listener = {
    .send = csrc_send,
    .cancelled = csrc_cancelled,
};

/* ---- data-control device: report what a windowless client sees -------- */

static void coffer_offer(void *data, struct zwlr_data_control_offer_v1 *o,
                         const char *mime) {
    mimes_add(data, mime);
}
static const struct zwlr_data_control_offer_v1_listener coffer_listener = {
    .offer = coffer_offer,
};
static void cdev_data_offer(void *data, struct zwlr_data_control_device_v1 *d,
                            struct zwlr_data_control_offer_v1 *offer) {
    zwlr_data_control_offer_v1_add_listener(
        offer, &coffer_listener, calloc(1, sizeof(struct offer_mimes)));
}
static void cdev_selection(void *data, struct zwlr_data_control_device_v1 *d,
                           struct zwlr_data_control_offer_v1 *offer) {
    if (!offer) {
        say("CLIP_CONTROL_SELECTION empty");
        return;
    }
    struct offer_mimes *m = zwlr_data_control_offer_v1_get_user_data(offer);
    say("CLIP_CONTROL_SELECTION mimes=%d", m->n);
    mimes_free(m);
    zwlr_data_control_offer_v1_destroy(offer);
}
static void cdev_finished(void *data, struct zwlr_data_control_device_v1 *d) {}
static void cdev_primary_selection(void *data,
                                   struct zwlr_data_control_device_v1 *d,
                                   struct zwlr_data_control_offer_v1 *o) {}
static const struct zwlr_data_control_device_v1_listener cdev_listener = {
    .data_offer = cdev_data_offer,
    .selection = cdev_selection,
    .finished = cdev_finished,
    .primary_selection = cdev_primary_selection,
};

/* ---- keyboard ---------------------------------------------------------- */

static void kbd_keymap(void *data, struct wl_keyboard *k, uint32_t format,
                       int32_t fd, uint32_t size) {
    char *map = mmap(NULL, size, PROT_READ, MAP_PRIVATE, fd, 0);
    if (map != MAP_FAILED) {
        c.xkb_ctx = xkb_context_new(XKB_CONTEXT_NO_DEFAULT_INCLUDES);
        if (c.xkb_ctx)
            c.keymap = xkb_keymap_new_from_string(c.xkb_ctx, map,
                                                  XKB_KEYMAP_FORMAT_TEXT_V1,
                                                  XKB_KEYMAP_COMPILE_NO_FLAGS);
        munmap(map, size);
    }
    close(fd);
}
static void kbd_enter(void *data, struct wl_keyboard *k, uint32_t serial,
                      struct wl_surface *surf, struct wl_array *keys) {
    c.focused = 1;
    c.enter_serial = serial;
    say("CLIP_ENTER");
}
static void kbd_leave(void *data, struct wl_keyboard *k, uint32_t serial,
                      struct wl_surface *surf) {
    c.focused = 0;
}
/* The modifiers in effect, by name, for the key events that follow. */
static void mod_names(char *out, size_t cap) {
    static const char *const names[][2] = {
        { XKB_MOD_NAME_CTRL, "ctrl" }, { XKB_MOD_NAME_SHIFT, "shift" },
        { XKB_MOD_NAME_ALT, "alt" },   { XKB_MOD_NAME_LOGO, "super" },
    };
    out[0] = '\0';
    for (size_t i = 0; c.keymap && i < sizeof(names) / sizeof(names[0]); i++) {
        xkb_mod_index_t idx = xkb_keymap_mod_get_index(c.keymap, names[i][0]);
        if (idx == XKB_MOD_INVALID || !(c.mods_depressed & (1u << idx)))
            continue;
        size_t n = strlen(out);
        snprintf(out + n, cap - n, "%s%s", n ? "+" : "", names[i][1]);
    }
    if (!out[0]) snprintf(out, cap, "none");
}
static void kbd_key(void *data, struct wl_keyboard *k, uint32_t serial,
                    uint32_t time, uint32_t key, uint32_t state) {
    char mods[64];
    mod_names(mods, sizeof(mods));
    say("CLIP_KEY key=%u state=%u mods=%s", key, state, mods);
    /* Count the chord's key, not the physical modifiers the compositor
     * forwards around it (Ctrl, Shift, Alt, Super; left and right). */
    static const uint32_t modifier_keys[] = { 29, 42, 54, 56, 97, 100, 125, 126 };
    int is_modifier = 0;
    for (size_t i = 0; i < sizeof(modifier_keys) / sizeof(modifier_keys[0]); i++)
        if (key == modifier_keys[i]) is_modifier = 1;
    if (state == WL_KEYBOARD_KEY_STATE_PRESSED && !is_modifier) c.keys_seen++;
}
static void kbd_modifiers(void *data, struct wl_keyboard *k, uint32_t serial,
                          uint32_t dep, uint32_t lat, uint32_t lock,
                          uint32_t group) {
    c.mods_depressed = dep;
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

/* ---- registry / xdg ---------------------------------------------------- */

static void registry_global(void *data, struct wl_registry *reg, uint32_t name,
                            const char *iface, uint32_t version) {
    if (!strcmp(iface, "wl_compositor"))
        c.compositor = wl_registry_bind(reg, name, &wl_compositor_interface, 4);
    else if (!strcmp(iface, "wl_shm"))
        c.shm = wl_registry_bind(reg, name, &wl_shm_interface, 1);
    else if (!strcmp(iface, "xdg_wm_base"))
        c.wm_base = wl_registry_bind(reg, name, &xdg_wm_base_interface, 1);
    else if (!strcmp(iface, "wl_seat"))
        c.seat = wl_registry_bind(reg, name, &wl_seat_interface, 1);
    else if (!strcmp(iface, "wl_data_device_manager"))
        c.ddm = wl_registry_bind(reg, name, &wl_data_device_manager_interface,
                                 version < 3 ? version : 3);
    else if (!strcmp(iface, "zwlr_data_control_manager_v1"))
        c.dcm = wl_registry_bind(reg, name,
                                 &zwlr_data_control_manager_v1_interface,
                                 version < 2 ? version : 2);
}
static void registry_global_remove(void *data, struct wl_registry *r,
                                   uint32_t name) {}
static const struct wl_registry_listener registry_listener = {
    .global = registry_global,
    .global_remove = registry_global_remove,
};

static void wm_base_ping(void *data, struct xdg_wm_base *b, uint32_t serial) {
    xdg_wm_base_pong(b, serial);
}
static const struct xdg_wm_base_listener wm_base_listener = {
    .ping = wm_base_ping,
};
static void xdg_surface_configure(void *data, struct xdg_surface *xs,
                                  uint32_t serial) {
    xdg_surface_ack_configure(xs, serial);
    c.configured = 1;
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

/* A grey window from a renderD128 dumb-bo, the shared-buffer path the
 * compositor imports (see wlclient-test.c). Mapping is what moves keyboard
 * focus to a new window. */
static int map_window(void) {
    c.surface = wl_compositor_create_surface(c.compositor);
    struct xdg_surface *xs = xdg_wm_base_get_xdg_surface(c.wm_base, c.surface);
    xdg_surface_add_listener(xs, &xdg_surface_listener, NULL);
    struct xdg_toplevel *top = xdg_surface_get_toplevel(xs);
    xdg_toplevel_add_listener(top, &toplevel_listener, NULL);
    xdg_toplevel_set_title(top, "wlclip-test");
    xdg_toplevel_set_app_id(top, c.app_id);
    wl_surface_commit(c.surface);
    while (!c.configured)
        if (wl_display_dispatch(c.display) < 0) return -1;

    int render = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC);
    if (render < 0) { perror("open renderD128"); return -1; }
    struct gbm_device *gbm = gbm_create_device(render);
    struct gbm_bo *bo = gbm ? gbm_bo_create(gbm, WIN_W, WIN_H,
                                            GBM_FORMAT_XRGB8888,
                                            GBM_BO_USE_LINEAR) : NULL;
    if (!bo) { fprintf(stderr, "gbm_bo_create\n"); return -1; }
    uint32_t stride = 0;
    void *map_data = NULL;
    uint32_t *px = gbm_bo_map(bo, 0, 0, WIN_W, WIN_H, 0, &stride, &map_data);
    if (!px) { fprintf(stderr, "gbm_bo_map\n"); return -1; }
    for (int i = 0; i < WIN_H * (int)(stride / 4); i++) px[i] = 0x00808080u;
    gbm_bo_unmap(bo, map_data);
    int prime = gbm_bo_get_fd(bo);
    if (prime < 0) { fprintf(stderr, "gbm_bo_get_fd\n"); return -1; }
    struct wl_shm_pool *pool =
        wl_shm_create_pool(c.shm, prime, (int32_t)(stride * WIN_H));
    struct wl_buffer *buf = wl_shm_pool_create_buffer(
        pool, 0, WIN_W, WIN_H, (int32_t)stride, WL_SHM_FORMAT_XRGB8888);
    wl_shm_pool_destroy(pool);
    close(prime);
    wl_surface_attach(c.surface, buf, 0, 0);
    wl_surface_damage(c.surface, 0, 0, WIN_W, WIN_H);
    wl_surface_commit(c.surface);
    return 0;
}

static int usage(void) {
    fprintf(stderr, "usage: wlclip-test [--app-id ID] "
                    "copy TEXT | paste | control-set TEXT | keys [N]\n");
    return 2;
}

int main(int argc, char **argv) {
    int ai = 1;
    c.app_id = "wlclip-test";
    if (ai + 1 < argc && !strcmp(argv[ai], "--app-id")) {
        c.app_id = argv[ai + 1];
        ai += 2;
    }
    if (ai >= argc) return usage();
    c.role = argv[ai];
    int is_copy = !strcmp(c.role, "copy");
    int is_paste = !strcmp(c.role, "paste");
    int is_control = !strcmp(c.role, "control-set");
    int is_keys = !strcmp(c.role, "keys");
    if ((is_copy || is_control) && ai + 1 >= argc) return usage();
    if (!is_copy && !is_paste && !is_control && !is_keys) return usage();
    if (is_copy || is_control) c.text = argv[ai + 1];
    c.keys_wanted = is_keys && ai + 1 < argc ? atoi(argv[ai + 1]) : 1;

    int fd = connect_socket();
    if (fd < 0) return 1;
    c.display = wl_display_connect_to_fd(fd);
    if (!c.display) { fprintf(stderr, "wl_display_connect_to_fd\n"); return 1; }
    struct wl_registry *registry = wl_display_get_registry(c.display);
    wl_registry_add_listener(registry, &registry_listener, NULL);
    wl_display_roundtrip(c.display);

    if (is_control) {
        if (!c.seat || !c.dcm) {
            fprintf(stderr, "no zwlr_data_control_manager_v1 global\n");
            return 1;
        }
        struct zwlr_data_control_device_v1 *dev =
            zwlr_data_control_manager_v1_get_data_device(c.dcm, c.seat);
        zwlr_data_control_device_v1_add_listener(dev, &cdev_listener, NULL);
        struct zwlr_data_control_source_v1 *src =
            zwlr_data_control_manager_v1_create_data_source(c.dcm);
        zwlr_data_control_source_v1_add_listener(src, &csrc_listener, NULL);
        zwlr_data_control_source_v1_offer(src, MIME_UTF8);
        zwlr_data_control_source_v1_offer(src, MIME_TEXT);
        zwlr_data_control_device_v1_set_selection(dev, src);
        wl_display_roundtrip(c.display);
        say("CLIP_CONTROL_SET");
        while (!c.cancelled)
            if (wl_display_dispatch(c.display) < 0) return 1;
        wl_display_disconnect(c.display);
        return 0;
    }

    if (!c.compositor || !c.shm || !c.wm_base || !c.seat || !c.ddm) {
        fprintf(stderr, "missing globals\n");
        return 1;
    }
    xdg_wm_base_add_listener(c.wm_base, &wm_base_listener, NULL);
    struct wl_keyboard *kbd = wl_seat_get_keyboard(c.seat);
    wl_keyboard_add_listener(kbd, &keyboard_listener, NULL);
    /* The data device exists before the window maps, so the offer the
     * compositor sends ahead of keyboard focus has somewhere to land. */
    struct wl_data_device *ddev =
        wl_data_device_manager_get_data_device(c.ddm, c.seat);
    wl_data_device_add_listener(ddev, &ddev_listener, NULL);
    if (map_window() != 0) return 1;

    while (!c.focused)
        if (wl_display_dispatch(c.display) < 0) return 1;

    if (is_copy) {
        struct wl_data_source *src =
            wl_data_device_manager_create_data_source(c.ddm);
        wl_data_source_add_listener(src, &dsrc_listener, NULL);
        wl_data_source_offer(src, MIME_UTF8);
        wl_data_source_offer(src, MIME_TEXT);
        wl_data_device_set_selection(ddev, src, c.enter_serial);
        wl_display_roundtrip(c.display);
        say("CLIP_COPY_SET");
        while (!c.cancelled)
            if (wl_display_dispatch(c.display) < 0) return 1;
    } else if (is_paste) {
        while (!c.pasted)
            if (wl_display_dispatch(c.display) < 0) return 1;
    } else {
        say("CLIP_KEYS_READY");
        while (c.keys_seen < c.keys_wanted)
            if (wl_display_dispatch(c.display) < 0) return 1;
        /* Let the release that follows the last press arrive and print. */
        wl_display_roundtrip(c.display);
    }
    wl_display_disconnect(c.display);
    return 0;
}
