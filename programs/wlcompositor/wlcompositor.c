/*
 * wlcompositor — a minimal but real PID-2 Wayland compositor for the
 * wasm32 POSIX kernel (DRI plan §5 PR6). It is a genuine libwayland
 * *server*: it runs libwayland's wl_event_loop on the kernel's epoll,
 * listens on an AF_UNIX socket at /run/wayland-0, holds DRM master on
 * card0, and drives real input from the ported libinput 1.25.0 path
 * backend. Nothing here is mocked — clients speak the real wire protocol.
 *
 * v1 interface set (plan §"v1 Wayland interface set"):
 *   wl_compositor + wl_surface + wl_region
 *   wl_shm + wl_shm_pool + wl_buffer   (via libwayland's built-in shm)
 *   xdg_wm_base + xdg_surface + xdg_toplevel
 *   wl_seat + wl_keyboard + wl_pointer
 *   wl_output
 *
 * Compositing is the CPU (wl_shm) tier: a client renders ARGB/XRGB pixels
 * into a shared-memory pool, the pool fd rides SCM_RIGHTS to us, and we
 * CPU-blit the committed buffer into a scanout gbm_bo that we page-flip
 * onto card0. Clients are paced with wl_surface.frame callbacks fired on
 * flip completion. Input from libinput (keyboard + pointer) is fanned to
 * the focused client's wl_keyboard / wl_pointer resources; ESC is
 * forwarded, never special-cased.
 *
 * The process exits 0 once its last client disconnects, so the PR6 gate
 * (host/test/wlcompositor-smoke.test.ts) can spawn compositor + client and
 * observe a clean shutdown.
 *
 * This is where the real libinput becomes a real consumer and where the
 * PR1 libffi closure shim is exercised end-to-end by a standalone server
 * dispatching decoded requests.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include <wayland-server.h>
#include <wayland-server-protocol.h>
#include "xdg-shell-server-protocol.h"

#include <xkbcommon/xkbcommon.h>
#include <libinput.h>

#include <gbm.h>
#include <xf86drm.h>
#include <xf86drmMode.h>
#include <drm/drm_fourcc.h>

/* The Wayland runtime dir. / is a read-only rootfs and /var/run is a
 * root-owned 0755 scratch mount, so under this kernel the only dir writable
 * by any uid is /tmp (mode 1777) — it plays the XDG_RUNTIME_DIR role here. */
#define WL_SOCKET_PATH "/tmp/wayland-0"
#define WL_KEYMAP_PATH "/tmp/wlcompositor-keymap.xkb"
#define MAX_INPUT_RES  8      /* keyboard/pointer resources we track */
#define MAX_FRAME_CB   32     /* pending frame callbacks per surface */

/* ---- surface state ----------------------------------------------------- */

/* A wl_surface plus the double-buffered commit state v1 cares about: the
 * currently-attached wl_buffer and the frame callbacks awaiting the next
 * flip. Position is fixed at (0,0) — v1 shows one fullscreen-anchored
 * toplevel. */
struct surface {
    struct wl_resource *resource;      /* the wl_surface */
    struct wl_resource *pending_buffer; /* set by attach, consumed by commit */
    struct wl_resource *buffer;         /* committed, awaiting composite */
    struct wl_resource *xdg_surface;    /* xdg_surface wrapping this surface */
    struct wl_resource *xdg_toplevel;
    int32_t x, y;                       /* top-left on the output */
    int mapped;                         /* has a committed buffer been shown */
    struct wl_resource *frame_cbs[MAX_FRAME_CB];
    int n_frame_cbs;
};

/* ---- wl_shm pool / buffer (custom, gbm-backed) ------------------------- */

/* libwayland's built-in wl_shm mmaps the client's pool fd directly, but on
 * this kernel a plain file/memfd mmap is NOT shared across processes — only
 * the DRI bo registry is (host SharedArrayBuffer). So the client backs its
 * pool with a renderD128 dumb-bo and passes its prime-fd; we import that
 * prime-fd via gbm and map it, aliasing the same shared bytes. This is the
 * "gbm_bo_import path for wl_shm" the plan names (§8.1). v1 handles the
 * common single-buffer, offset-0, XRGB/ARGB8888 case. */
struct shm_pool {
    int fd;
    int32_t size;
    int refcount;   /* pool resource (1) + one per live buffer */
};
struct shm_buffer {
    struct shm_pool *pool;
    int32_t offset, width, height, stride;
    uint32_t format;
    struct gbm_bo *bo;      /* lazily imported on first composite */
    void *map_data;
    uint32_t *pixels;       /* shared mapping of the client's bytes */
    uint32_t map_stride_px;
};

/* ---- compositor singleton ---------------------------------------------- */

struct compositor {
    struct wl_display *display;
    struct wl_event_loop *loop;

    /* DRM / KMS scanout. */
    int card_fd;
    uint32_t crtc_id;
    uint32_t connector_id;
    drmModeModeInfo mode;
    uint32_t width, height;
    struct gbm_device *gbm;
    struct gbm_surface *gbm_surface;
    struct gbm_bo *displayed_bo;   /* on-screen right now */
    struct gbm_bo *pending_bo;     /* flip queued, not yet complete */
    int crtc_configured;           /* SetCrtc done once */

    /* Input. */
    struct libinput *li;
    int xkb_keymap_fd;
    uint32_t xkb_keymap_size;
    double cursor_x, cursor_y;

    /* The single focused surface (v1). */
    struct surface *focus;

    /* Bound seat resources (one client in v1, but track a few). */
    struct wl_resource *keyboards[MAX_INPUT_RES];
    struct wl_resource *pointers[MAX_INPUT_RES];

    int client_count;
    int had_client;   /* so we only exit after a client has actually connected */
    int repaint_needed;
    int sampled;      /* printed the one-shot composite sample */
};

static struct compositor g;

static uint32_t now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint32_t)(ts.tv_sec * 1000u + ts.tv_nsec / 1000000u);
}

/* Track a resource pointer in a fixed slot array; destroy handlers null the
 * slot so a disconnected client's resource is never sent to (no UAF). */
static void slot_add(struct wl_resource **slots, struct wl_resource *r) {
    for (int i = 0; i < MAX_INPUT_RES; i++)
        if (!slots[i]) { slots[i] = r; return; }
}
static void slot_remove(struct wl_resource **slots, struct wl_resource *r) {
    for (int i = 0; i < MAX_INPUT_RES; i++)
        if (slots[i] == r) { slots[i] = NULL; return; }
}

/* ====================================================================== */
/* wl_surface                                                             */
/* ====================================================================== */

static void surface_destroy(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static void surface_attach(struct wl_client *c, struct wl_resource *r,
                           struct wl_resource *buffer, int32_t x, int32_t y) {
    struct surface *s = wl_resource_get_user_data(r);
    s->pending_buffer = buffer;
}
static void surface_damage(struct wl_client *c, struct wl_resource *r,
                           int32_t x, int32_t y, int32_t w, int32_t h) {}
static void surface_frame(struct wl_client *c, struct wl_resource *r,
                          uint32_t callback) {
    struct surface *s = wl_resource_get_user_data(r);
    struct wl_resource *cb =
        wl_resource_create(c, &wl_callback_interface, 1, callback);
    if (!cb) { wl_client_post_no_memory(c); return; }
    /* No implementation: a wl_callback only ever emits `done`. */
    wl_resource_set_implementation(cb, NULL, NULL, NULL);
    if (s->n_frame_cbs < MAX_FRAME_CB)
        s->frame_cbs[s->n_frame_cbs++] = cb;
    else
        wl_callback_send_done(cb, now_ms()), wl_resource_destroy(cb);
}
static void surface_set_opaque_region(struct wl_client *c, struct wl_resource *r,
                                      struct wl_resource *reg) {}
static void surface_set_input_region(struct wl_client *c, struct wl_resource *r,
                                     struct wl_resource *reg) {}
static void schedule_repaint(void);
static void focus_surface_inputs(struct surface *s);
static void surface_commit(struct wl_client *c, struct wl_resource *r) {
    struct surface *s = wl_resource_get_user_data(r);
    /* Apply double-buffered state: the pending attach becomes current. */
    s->buffer = s->pending_buffer;
    s->pending_buffer = NULL;
    if (s->buffer) {
        int was_mapped = s->mapped;
        s->mapped = 1;
        g.focus = s;
        /* On the first map, hand this surface keyboard + pointer focus.
         * Seat resources bound after the map get focus in get_*; this
         * covers the bind-before-map ordering. */
        if (!was_mapped)
            focus_surface_inputs(s);
    }
    schedule_repaint();
}
static void surface_set_buffer_transform(struct wl_client *c,
                                         struct wl_resource *r, int32_t t) {}
static void surface_set_buffer_scale(struct wl_client *c, struct wl_resource *r,
                                     int32_t s) {}
static void surface_damage_buffer(struct wl_client *c, struct wl_resource *r,
                                  int32_t x, int32_t y, int32_t w, int32_t h) {}
static void surface_offset(struct wl_client *c, struct wl_resource *r,
                           int32_t x, int32_t y) {}

static const struct wl_surface_interface surface_impl = {
    .destroy = surface_destroy,
    .attach = surface_attach,
    .damage = surface_damage,
    .frame = surface_frame,
    .set_opaque_region = surface_set_opaque_region,
    .set_input_region = surface_set_input_region,
    .commit = surface_commit,
    .set_buffer_transform = surface_set_buffer_transform,
    .set_buffer_scale = surface_set_buffer_scale,
    .damage_buffer = surface_damage_buffer,
    .offset = surface_offset,
};

static void surface_resource_destroy(struct wl_resource *r) {
    struct surface *s = wl_resource_get_user_data(r);
    if (g.focus == s) g.focus = NULL;
    /* Fire any outstanding frame callbacks so the client's event queue
     * doesn't leak; they're owned by the client and freed with it, but
     * clearing our references avoids a dangling send after destroy. */
    s->n_frame_cbs = 0;
    free(s);
}

/* ====================================================================== */
/* wl_shm / wl_shm_pool / wl_buffer                                       */
/* ====================================================================== */

static void shm_pool_free(struct shm_pool *p) {
    if (p->fd >= 0) close(p->fd);
    free(p);
}

/* Import + map the client's dumb-bo on first use; the mapping aliases the
 * shared host buffer, so later reads see the client's latest pixels. */
static uint32_t *shm_buffer_pixels(struct shm_buffer *b, uint32_t *stride_px) {
    if (!b->bo) {
        struct gbm_import_fd_data d = {
            .fd = b->pool->fd,
            .width = (uint32_t)b->width,
            .height = (uint32_t)b->height,
            .stride = (uint32_t)b->stride,
            .format = DRM_FORMAT_XRGB8888,
        };
        b->bo = gbm_bo_import(g.gbm, GBM_BO_IMPORT_FD, &d,
                              GBM_BO_USE_SCANOUT | GBM_BO_USE_LINEAR);
        if (!b->bo) { perror("gbm_bo_import"); return NULL; }
        uint32_t ms = 0;
        b->pixels = gbm_bo_map(b->bo, 0, 0, b->width, b->height, 0, &ms,
                               &b->map_data);
        if (!b->pixels) {
            perror("gbm_bo_map");
            gbm_bo_destroy(b->bo);
            b->bo = NULL;
            return NULL;
        }
        b->map_stride_px = ms / 4;
    }
    *stride_px = b->map_stride_px;
    return b->pixels;
}

static void buffer_destroy_req(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static const struct wl_buffer_interface buffer_impl = {
    .destroy = buffer_destroy_req,
};
static void buffer_resource_destroy(struct wl_resource *r) {
    struct shm_buffer *b = wl_resource_get_user_data(r);
    if (!b) return;
    if (b->bo) {
        if (b->map_data) gbm_bo_unmap(b->bo, b->map_data);
        gbm_bo_destroy(b->bo);
    }
    if (--b->pool->refcount == 0) shm_pool_free(b->pool);
    free(b);
}

static void pool_create_buffer(struct wl_client *client, struct wl_resource *r,
                               uint32_t id, int32_t offset, int32_t width,
                               int32_t height, int32_t stride,
                               uint32_t format) {
    struct shm_pool *p = wl_resource_get_user_data(r);
    if (offset != 0) {   /* v1: one buffer at the base of the pool */
        wl_resource_post_error(r, WL_SHM_ERROR_INVALID_STRIDE,
                               "v1 compositor supports only offset 0");
        return;
    }
    if (format != WL_SHM_FORMAT_XRGB8888 && format != WL_SHM_FORMAT_ARGB8888) {
        wl_resource_post_error(r, WL_SHM_ERROR_INVALID_FORMAT,
                               "unsupported wl_shm format");
        return;
    }
    struct shm_buffer *b = calloc(1, sizeof(*b));
    if (!b) { wl_client_post_no_memory(client); return; }
    b->pool = p;
    b->offset = offset;
    b->width = width;
    b->height = height;
    b->stride = stride;
    b->format = format;
    struct wl_resource *br =
        wl_resource_create(client, &wl_buffer_interface, 1, id);
    if (!br) { free(b); wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(br, &buffer_impl, b, buffer_resource_destroy);
    p->refcount++;
}
static void pool_destroy_req(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static void pool_resize(struct wl_client *c, struct wl_resource *r,
                        int32_t size) {
    struct shm_pool *p = wl_resource_get_user_data(r);
    if (size > p->size) p->size = size;
}
static const struct wl_shm_pool_interface pool_impl = {
    .create_buffer = pool_create_buffer,
    .destroy = pool_destroy_req,
    .resize = pool_resize,
};
static void pool_resource_destroy(struct wl_resource *r) {
    struct shm_pool *p = wl_resource_get_user_data(r);
    if (--p->refcount == 0) shm_pool_free(p);
}

static void shm_create_pool(struct wl_client *client, struct wl_resource *r,
                            uint32_t id, int32_t fd, int32_t size) {
    struct shm_pool *p = calloc(1, sizeof(*p));
    if (!p) { close(fd); wl_client_post_no_memory(client); return; }
    p->fd = fd;
    p->size = size;
    p->refcount = 1;
    struct wl_resource *pr = wl_resource_create(
        client, &wl_shm_pool_interface, wl_resource_get_version(r), id);
    if (!pr) { close(fd); free(p); wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(pr, &pool_impl, p, pool_resource_destroy);
}
static void shm_release(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static const struct wl_shm_interface shm_impl = {
    .create_pool = shm_create_pool,
    .release = shm_release,
};
static void shm_bind(struct wl_client *client, void *data, uint32_t version,
                     uint32_t id) {
    struct wl_resource *r =
        wl_resource_create(client, &wl_shm_interface, version, id);
    if (!r) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(r, &shm_impl, NULL, NULL);
    wl_shm_send_format(r, WL_SHM_FORMAT_XRGB8888);
    wl_shm_send_format(r, WL_SHM_FORMAT_ARGB8888);
}

/* ====================================================================== */
/* wl_compositor                                                          */
/* ====================================================================== */

static void compositor_create_surface(struct wl_client *client,
                                      struct wl_resource *resource,
                                      uint32_t id) {
    struct surface *s = calloc(1, sizeof(*s));
    if (!s) { wl_client_post_no_memory(client); return; }
    s->resource = wl_resource_create(client, &wl_surface_interface,
                                     wl_resource_get_version(resource), id);
    if (!s->resource) { free(s); wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(s->resource, &surface_impl, s,
                                   surface_resource_destroy);
}

/* wl_region is accepted but has no compositing effect in v1 (surfaces are
 * treated as fully opaque and input-covering). */
static void region_add(struct wl_client *c, struct wl_resource *r,
                       int32_t x, int32_t y, int32_t w, int32_t h) {}
static void region_subtract(struct wl_client *c, struct wl_resource *r,
                            int32_t x, int32_t y, int32_t w, int32_t h) {}
static void region_destroy(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static const struct wl_region_interface region_impl = {
    .destroy = region_destroy,
    .add = region_add,
    .subtract = region_subtract,
};
static void compositor_create_region(struct wl_client *client,
                                     struct wl_resource *resource,
                                     uint32_t id) {
    struct wl_resource *r = wl_resource_create(
        client, &wl_region_interface, wl_resource_get_version(resource), id);
    if (!r) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(r, &region_impl, NULL, NULL);
}

static const struct wl_compositor_interface compositor_impl = {
    .create_surface = compositor_create_surface,
    .create_region = compositor_create_region,
};

static void compositor_bind(struct wl_client *client, void *data,
                            uint32_t version, uint32_t id) {
    struct wl_resource *r =
        wl_resource_create(client, &wl_compositor_interface, version, id);
    if (!r) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(r, &compositor_impl, NULL, NULL);
}

/* ====================================================================== */
/* xdg_shell (xdg_wm_base / xdg_surface / xdg_toplevel)                    */
/* ====================================================================== */

static void toplevel_destroy(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static void toplevel_set_parent(struct wl_client *c, struct wl_resource *r,
                                struct wl_resource *parent) {}
static void toplevel_set_title(struct wl_client *c, struct wl_resource *r,
                               const char *title) {}
static void toplevel_set_app_id(struct wl_client *c, struct wl_resource *r,
                                const char *app_id) {}
static void toplevel_show_window_menu(struct wl_client *c, struct wl_resource *r,
                                      struct wl_resource *seat, uint32_t serial,
                                      int32_t x, int32_t y) {}
static void toplevel_move(struct wl_client *c, struct wl_resource *r,
                          struct wl_resource *seat, uint32_t serial) {}
static void toplevel_resize(struct wl_client *c, struct wl_resource *r,
                            struct wl_resource *seat, uint32_t serial,
                            uint32_t edges) {}
static void toplevel_set_max_size(struct wl_client *c, struct wl_resource *r,
                                  int32_t w, int32_t h) {}
static void toplevel_set_min_size(struct wl_client *c, struct wl_resource *r,
                                  int32_t w, int32_t h) {}
static void toplevel_set_maximized(struct wl_client *c, struct wl_resource *r) {}
static void toplevel_unset_maximized(struct wl_client *c, struct wl_resource *r) {}
static void toplevel_set_fullscreen(struct wl_client *c, struct wl_resource *r,
                                    struct wl_resource *output) {}
static void toplevel_unset_fullscreen(struct wl_client *c,
                                      struct wl_resource *r) {}
static void toplevel_set_minimized(struct wl_client *c, struct wl_resource *r) {}
static const struct xdg_toplevel_interface toplevel_impl = {
    .destroy = toplevel_destroy,
    .set_parent = toplevel_set_parent,
    .set_title = toplevel_set_title,
    .set_app_id = toplevel_set_app_id,
    .show_window_menu = toplevel_show_window_menu,
    .move = toplevel_move,
    .resize = toplevel_resize,
    .set_max_size = toplevel_set_max_size,
    .set_min_size = toplevel_set_min_size,
    .set_maximized = toplevel_set_maximized,
    .unset_maximized = toplevel_unset_maximized,
    .set_fullscreen = toplevel_set_fullscreen,
    .unset_fullscreen = toplevel_unset_fullscreen,
    .set_minimized = toplevel_set_minimized,
};

static void xdg_surface_destroy(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static void xdg_surface_get_toplevel(struct wl_client *client,
                                     struct wl_resource *resource,
                                     uint32_t id) {
    struct surface *s = wl_resource_get_user_data(resource);
    struct wl_resource *tl = wl_resource_create(
        client, &xdg_toplevel_interface, wl_resource_get_version(resource), id);
    if (!tl) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(tl, &toplevel_impl, s, NULL);
    if (s) s->xdg_toplevel = tl;

    /* Advertise a suggested size of 0x0 ("you decide") plus the initial
     * configure. The window is not mapped until the client acks and
     * commits a buffer. */
    struct wl_array states;
    wl_array_init(&states);
    uint32_t *st = wl_array_add(&states, sizeof(uint32_t));
    if (st) *st = XDG_TOPLEVEL_STATE_ACTIVATED;
    xdg_toplevel_send_configure(tl, (int32_t)g.width, (int32_t)g.height,
                                &states);
    wl_array_release(&states);
    xdg_surface_send_configure(resource, wl_display_next_serial(g.display));
}
static void xdg_surface_get_popup(struct wl_client *c, struct wl_resource *r,
                                  uint32_t id, struct wl_resource *parent,
                                  struct wl_resource *positioner) {
    /* xdg_popup is deferred to PR8; reject rather than half-implement. */
    wl_resource_post_error(r, XDG_WM_BASE_ERROR_INVALID_POPUP_PARENT,
                           "xdg_popup unsupported in v1");
}
static void xdg_surface_set_window_geometry(struct wl_client *c,
                                            struct wl_resource *r, int32_t x,
                                            int32_t y, int32_t w, int32_t h) {}
static void xdg_surface_ack_configure(struct wl_client *c, struct wl_resource *r,
                                      uint32_t serial) {}
static const struct xdg_surface_interface xdg_surface_impl = {
    .destroy = xdg_surface_destroy,
    .get_toplevel = xdg_surface_get_toplevel,
    .get_popup = xdg_surface_get_popup,
    .set_window_geometry = xdg_surface_set_window_geometry,
    .ack_configure = xdg_surface_ack_configure,
};

static void wm_base_destroy(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static void wm_base_create_positioner(struct wl_client *c, struct wl_resource *r,
                                      uint32_t id) {
    /* Positioners only matter for popups (PR8); hand back an inert object. */
    struct wl_resource *p = wl_resource_create(
        c, &xdg_positioner_interface, wl_resource_get_version(r), id);
    if (p) wl_resource_set_implementation(p, NULL, NULL, NULL);
}
static void wm_base_get_xdg_surface(struct wl_client *client,
                                    struct wl_resource *resource, uint32_t id,
                                    struct wl_resource *surface) {
    struct surface *s = wl_resource_get_user_data(surface);
    struct wl_resource *xs = wl_resource_create(
        client, &xdg_surface_interface, wl_resource_get_version(resource), id);
    if (!xs) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(xs, &xdg_surface_impl, s, NULL);
    if (s) s->xdg_surface = xs;
}
static void wm_base_pong(struct wl_client *c, struct wl_resource *r,
                         uint32_t serial) {}
static const struct xdg_wm_base_interface wm_base_impl = {
    .destroy = wm_base_destroy,
    .create_positioner = wm_base_create_positioner,
    .get_xdg_surface = wm_base_get_xdg_surface,
    .pong = wm_base_pong,
};
static void wm_base_bind(struct wl_client *client, void *data, uint32_t version,
                         uint32_t id) {
    struct wl_resource *r =
        wl_resource_create(client, &xdg_wm_base_interface, version, id);
    if (!r) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(r, &wm_base_impl, NULL, NULL);
}

/* ====================================================================== */
/* wl_seat / wl_keyboard / wl_pointer                                     */
/* ====================================================================== */

static void keyboard_release(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static const struct wl_keyboard_interface keyboard_impl = {
    .release = keyboard_release,
};
static void keyboard_resource_destroy(struct wl_resource *r) {
    slot_remove(g.keyboards, r);
}

static void pointer_set_cursor(struct wl_client *c, struct wl_resource *r,
                               uint32_t serial, struct wl_resource *surface,
                               int32_t hx, int32_t hy) {}
static void pointer_release(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static const struct wl_pointer_interface pointer_impl = {
    .set_cursor = pointer_set_cursor,
    .release = pointer_release,
};
static void pointer_resource_destroy(struct wl_resource *r) {
    slot_remove(g.pointers, r);
}

/* Once a client binds a keyboard, hand it the keymap immediately. The
 * enter (focus) is sent when a surface is mapped. */
static void send_keymap(struct wl_resource *kbd) {
    wl_keyboard_send_keymap(kbd, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1,
                            g.xkb_keymap_fd, g.xkb_keymap_size);
}

static void seat_get_pointer(struct wl_client *client,
                             struct wl_resource *resource, uint32_t id) {
    struct wl_resource *p = wl_resource_create(
        client, &wl_pointer_interface, wl_resource_get_version(resource), id);
    if (!p) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(p, &pointer_impl, NULL,
                                   pointer_resource_destroy);
    slot_add(g.pointers, p);
    /* If a surface is already focused, enter it now. */
    if (g.focus && g.focus->mapped)
        wl_pointer_send_enter(p, wl_display_next_serial(g.display),
                              g.focus->resource,
                              wl_fixed_from_double(g.cursor_x),
                              wl_fixed_from_double(g.cursor_y));
}
static void seat_get_keyboard(struct wl_client *client,
                              struct wl_resource *resource, uint32_t id) {
    struct wl_resource *k = wl_resource_create(
        client, &wl_keyboard_interface, wl_resource_get_version(resource), id);
    if (!k) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(k, &keyboard_impl, NULL,
                                   keyboard_resource_destroy);
    slot_add(g.keyboards, k);
    send_keymap(k);
    if (g.focus && g.focus->mapped) {
        struct wl_array keys;
        wl_array_init(&keys);
        wl_keyboard_send_enter(k, wl_display_next_serial(g.display),
                               g.focus->resource, &keys);
        wl_array_release(&keys);
    }
}
static void seat_get_touch(struct wl_client *client, struct wl_resource *resource,
                           uint32_t id) {
    /* No touch device in v1; create an inert resource so the client's
     * new_id isn't left dangling. */
    struct wl_resource *t = wl_resource_create(
        client, &wl_touch_interface, wl_resource_get_version(resource), id);
    if (t) wl_resource_set_implementation(t, NULL, NULL, NULL);
}
static void seat_release(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static const struct wl_seat_interface seat_impl = {
    .get_pointer = seat_get_pointer,
    .get_keyboard = seat_get_keyboard,
    .get_touch = seat_get_touch,
    .release = seat_release,
};
static void seat_bind(struct wl_client *client, void *data, uint32_t version,
                      uint32_t id) {
    struct wl_resource *r =
        wl_resource_create(client, &wl_seat_interface, version, id);
    if (!r) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(r, &seat_impl, NULL, NULL);
    wl_seat_send_capabilities(
        r, WL_SEAT_CAPABILITY_KEYBOARD | WL_SEAT_CAPABILITY_POINTER);
}

/* Deliver keyboard focus (enter) to every bound keyboard for the mapped
 * surface. Called when a surface first maps. */
static void focus_surface_inputs(struct surface *s) {
    uint32_t serial = wl_display_next_serial(g.display);
    struct wl_array keys;
    wl_array_init(&keys);
    for (int i = 0; i < MAX_INPUT_RES; i++)
        if (g.keyboards[i])
            wl_keyboard_send_enter(g.keyboards[i], serial, s->resource, &keys);
    wl_array_release(&keys);
    for (int i = 0; i < MAX_INPUT_RES; i++)
        if (g.pointers[i])
            wl_pointer_send_enter(g.pointers[i], serial, s->resource,
                                  wl_fixed_from_double(g.cursor_x),
                                  wl_fixed_from_double(g.cursor_y));
}

/* ====================================================================== */
/* wl_output                                                              */
/* ====================================================================== */

static void output_release(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static const struct wl_output_interface output_impl = {
    .release = output_release,
};
static void output_bind(struct wl_client *client, void *data, uint32_t version,
                        uint32_t id) {
    struct wl_resource *r =
        wl_resource_create(client, &wl_output_interface, version, id);
    if (!r) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(r, &output_impl, NULL, NULL);
    wl_output_send_geometry(r, 0, 0, (int32_t)g.width, (int32_t)g.height,
                            WL_OUTPUT_SUBPIXEL_UNKNOWN, "Kandelo", "virtual-0",
                            WL_OUTPUT_TRANSFORM_NORMAL);
    wl_output_send_mode(r,
                        WL_OUTPUT_MODE_CURRENT | WL_OUTPUT_MODE_PREFERRED,
                        (int32_t)g.width, (int32_t)g.height, 60000);
    if (version >= WL_OUTPUT_DONE_SINCE_VERSION)
        wl_output_send_done(r);
}

/* ====================================================================== */
/* Compositing: CPU blit committed wl_shm buffers → scanout bo → PAGE_FLIP */
/* ====================================================================== */

/* ADDFB2 once per bo; cache the fb_id in the bo's user_data so repeated
 * flips of the same bo reuse it. */
static void bo_fb_destroy(struct gbm_bo *bo, void *data) {
    uint32_t fb_id = (uint32_t)(uintptr_t)data;
    if (fb_id) drmModeRmFB(g.card_fd, fb_id);
}
static uint32_t bo_get_fb(struct gbm_bo *bo) {
    uint32_t fb_id = (uint32_t)(uintptr_t)gbm_bo_get_user_data(bo);
    if (fb_id) return fb_id;
    uint32_t handle = gbm_bo_get_handle(bo).u32;
    uint32_t stride = gbm_bo_get_stride(bo);
    uint32_t handles[4] = { handle, 0, 0, 0 };
    uint32_t pitches[4] = { stride, 0, 0, 0 };
    uint32_t offsets[4] = { 0, 0, 0, 0 };
    if (drmModeAddFB2(g.card_fd, g.width, g.height, DRM_FORMAT_XRGB8888,
                      handles, pitches, offsets, &fb_id, 0) < 0) {
        perror("drmModeAddFB2");
        return 0;
    }
    gbm_bo_set_user_data(bo, (void *)(uintptr_t)fb_id, bo_fb_destroy);
    return fb_id;
}

/* Copy one committed wl_shm buffer into the scanout bo at the surface's
 * position, clipped to the output. XRGB/ARGB8888 both blit as 32-bit
 * words (we ignore alpha — v1 opaque compositing). */
static void blit_surface(struct surface *s, uint32_t *dst, uint32_t dst_stride_px) {
    struct shm_buffer *b = wl_resource_get_user_data(s->buffer);
    if (!b) return;
    uint32_t src_stride_px = 0;
    uint32_t *src = shm_buffer_pixels(b, &src_stride_px);
    if (!src) return;
    for (int32_t row = 0; row < b->height; row++) {
        int32_t dy = s->y + row;
        if (dy < 0 || dy >= (int32_t)g.height) continue;
        const uint32_t *srow = src + (size_t)row * src_stride_px;
        uint32_t *drow = dst + (size_t)dy * dst_stride_px;
        for (int32_t col = 0; col < b->width; col++) {
            int32_t dx = s->x + col;
            if (dx < 0 || dx >= (int32_t)g.width) continue;
            drow[dx] = srow[col];
        }
    }
}

static void send_frame_callbacks(struct surface *s) {
    uint32_t t = now_ms();
    for (int i = 0; i < s->n_frame_cbs; i++) {
        wl_callback_send_done(s->frame_cbs[i], t);
        wl_resource_destroy(s->frame_cbs[i]);
    }
    s->n_frame_cbs = 0;
}

/* Render one frame: lock a free scanout bo, clear it, blit the focused
 * surface, then SetCrtc (first frame) or queue a PAGE_FLIP. */
static void repaint(void) {
    if (!g.focus || !g.focus->mapped || !g.focus->buffer) return;
    if (!gbm_surface_has_free_buffers(g.gbm_surface)) return; /* retry on flip */

    struct gbm_bo *bo = gbm_surface_lock_front_buffer(g.gbm_surface);
    if (!bo) return;

    uint32_t stride = 0;
    void *map_data = NULL;
    uint32_t *dst = gbm_bo_map(bo, 0, 0, g.width, g.height, 0, &stride, &map_data);
    if (!dst) { gbm_surface_release_buffer(g.gbm_surface, bo); return; }
    uint32_t stride_px = stride / 4;

    /* Clear to an opaque dark background, then paint the client. */
    for (uint32_t y = 0; y < g.height; y++)
        for (uint32_t x = 0; x < g.width; x++)
            dst[y * stride_px + x] = 0xff101018u;
    blit_surface(g.focus, dst, stride_px);

    /* One-shot proof that the client's pixels crossed the process boundary:
     * sample a pixel inside the focused surface. If the gbm_bo_import path
     * (§8.1) worked, this is the client's color; if the shared read silently
     * failed we'd see the clear color instead. The gate asserts on it. */
    if (!g.sampled) {
        int32_t sx = g.focus->x + 10, sy = g.focus->y + 10;
        if (sx >= 0 && sx < (int32_t)g.width && sy >= 0 &&
            sy < (int32_t)g.height) {
            printf("COMPOSITE_SAMPLE x=%d y=%d px=0x%08x\n", sx, sy,
                   dst[(size_t)sy * stride_px + sx]);
            fflush(stdout);
            g.sampled = 1;
        }
    }
    gbm_bo_unmap(bo, map_data);

    /* We've copied the pixels; release the client buffer so it can render
     * the next frame while this one scans out. */
    if (g.focus->buffer) {
        wl_buffer_send_release(g.focus->buffer);
        g.focus->buffer = NULL;
    }

    uint32_t fb_id = bo_get_fb(bo);
    if (!fb_id) { gbm_surface_release_buffer(g.gbm_surface, bo); return; }

    if (!g.crtc_configured) {
        if (drmModeSetCrtc(g.card_fd, g.crtc_id, fb_id, 0, 0,
                           &g.connector_id, 1, &g.mode) < 0) {
            perror("drmModeSetCrtc");
            gbm_surface_release_buffer(g.gbm_surface, bo);
            return;
        }
        g.crtc_configured = 1;
        g.displayed_bo = bo;
        printf("FLIP fb=%u first=1\n", fb_id);
        fflush(stdout);
        send_frame_callbacks(g.focus);
    } else {
        if (drmModePageFlip(g.card_fd, g.crtc_id, fb_id,
                            DRM_MODE_PAGE_FLIP_EVENT, NULL) < 0) {
            perror("drmModePageFlip");
            gbm_surface_release_buffer(g.gbm_surface, bo);
            return;
        }
        g.pending_bo = bo;
    }
}

static void schedule_repaint(void) {
    /* If a flip is in flight, defer; the flip-complete handler repaints. */
    if (g.pending_bo) { g.repaint_needed = 1; return; }
    repaint();
}

/* card0 became readable → a page-flip completed. Release the previously
 * displayed bo, fire frame callbacks, and repaint if the client committed
 * again while the flip was in flight. */
static void on_flip(int fd, unsigned int seq, unsigned int sec,
                    unsigned int usec, void *user_data) {
    if (g.pending_bo) {
        if (g.displayed_bo)
            gbm_surface_release_buffer(g.gbm_surface, g.displayed_bo);
        g.displayed_bo = g.pending_bo;
        g.pending_bo = NULL;
        printf("FLIP done\n");
        fflush(stdout);
        if (g.focus) send_frame_callbacks(g.focus);
    }
    if (g.repaint_needed && !g.pending_bo) {
        g.repaint_needed = 0;
        repaint();
    }
}
static int card_readable(int fd, uint32_t mask, void *data) {
    drmEventContext ctx;
    memset(&ctx, 0, sizeof(ctx));
    ctx.version = 2;
    ctx.page_flip_handler = on_flip;
    drmHandleEvent(g.card_fd, &ctx);
    return 0;
}

/* ====================================================================== */
/* Input: libinput → wl_keyboard / wl_pointer                             */
/* ====================================================================== */

static void handle_keyboard(struct libinput_event_keyboard *k) {
    uint32_t key = libinput_event_keyboard_get_key(k);
    uint32_t state = libinput_event_keyboard_get_key_state(k) ==
                             LIBINPUT_KEY_STATE_PRESSED
                         ? WL_KEYBOARD_KEY_STATE_PRESSED
                         : WL_KEYBOARD_KEY_STATE_RELEASED;
    uint32_t serial = wl_display_next_serial(g.display);
    uint32_t t = now_ms();
    printf("KEY key=%u state=%u\n", key, state);
    fflush(stdout);
    for (int i = 0; i < MAX_INPUT_RES; i++)
        if (g.keyboards[i])
            wl_keyboard_send_key(g.keyboards[i], serial, t, key, state);
}

static void handle_pointer_motion_abs(struct libinput_event_pointer *p) {
    g.cursor_x = libinput_event_pointer_get_absolute_x_transformed(p, g.width);
    g.cursor_y = libinput_event_pointer_get_absolute_y_transformed(p, g.height);
    uint32_t t = now_ms();
    printf("PTR x=%d y=%d\n", (int)g.cursor_x, (int)g.cursor_y);
    fflush(stdout);
    for (int i = 0; i < MAX_INPUT_RES; i++)
        if (g.pointers[i])
            wl_pointer_send_motion(g.pointers[i], t,
                                   wl_fixed_from_double(g.cursor_x),
                                   wl_fixed_from_double(g.cursor_y));
}

static void handle_pointer_motion_rel(struct libinput_event_pointer *p) {
    g.cursor_x += libinput_event_pointer_get_dx(p);
    g.cursor_y += libinput_event_pointer_get_dy(p);
    if (g.cursor_x < 0) g.cursor_x = 0;
    if (g.cursor_y < 0) g.cursor_y = 0;
    if (g.cursor_x > g.width) g.cursor_x = g.width;
    if (g.cursor_y > g.height) g.cursor_y = g.height;
    uint32_t t = now_ms();
    printf("PTR x=%d y=%d\n", (int)g.cursor_x, (int)g.cursor_y);
    fflush(stdout);
    for (int i = 0; i < MAX_INPUT_RES; i++)
        if (g.pointers[i])
            wl_pointer_send_motion(g.pointers[i], t,
                                   wl_fixed_from_double(g.cursor_x),
                                   wl_fixed_from_double(g.cursor_y));
}

static void handle_pointer_button(struct libinput_event_pointer *p) {
    uint32_t button = libinput_event_pointer_get_button(p);
    uint32_t state = libinput_event_pointer_get_button_state(p) ==
                             LIBINPUT_BUTTON_STATE_PRESSED
                         ? WL_POINTER_BUTTON_STATE_PRESSED
                         : WL_POINTER_BUTTON_STATE_RELEASED;
    uint32_t serial = wl_display_next_serial(g.display);
    uint32_t t = now_ms();
    printf("BTN button=%u state=%u\n", button, state);
    fflush(stdout);
    for (int i = 0; i < MAX_INPUT_RES; i++)
        if (g.pointers[i])
            wl_pointer_send_button(g.pointers[i], serial, t, button, state);
}

static int libinput_readable(int fd, uint32_t mask, void *data) {
    libinput_dispatch(g.li);
    struct libinput_event *ev;
    while ((ev = libinput_get_event(g.li)) != NULL) {
        switch (libinput_event_get_type(ev)) {
        case LIBINPUT_EVENT_KEYBOARD_KEY:
            handle_keyboard(libinput_event_get_keyboard_event(ev));
            break;
        case LIBINPUT_EVENT_POINTER_MOTION:
            handle_pointer_motion_rel(libinput_event_get_pointer_event(ev));
            break;
        case LIBINPUT_EVENT_POINTER_MOTION_ABSOLUTE:
            handle_pointer_motion_abs(libinput_event_get_pointer_event(ev));
            break;
        case LIBINPUT_EVENT_POINTER_BUTTON:
            handle_pointer_button(libinput_event_get_pointer_event(ev));
            break;
        default:
            break;
        }
        libinput_event_destroy(ev);
    }
    return 0;
}

static int li_open_restricted(const char *path, int flags, void *user_data) {
    int fd = open(path, flags);
    return fd < 0 ? -errno : fd;
}
static void li_close_restricted(int fd, void *user_data) { close(fd); }
static const struct libinput_interface li_interface = {
    .open_restricted = li_open_restricted,
    .close_restricted = li_close_restricted,
};

/* ====================================================================== */
/* Client lifecycle                                                       */
/* ====================================================================== */

static void client_destroyed(struct wl_listener *listener, void *data) {
    free(listener);
    if (--g.client_count <= 0 && g.had_client) {
        printf("COMPOSITOR_LAST_CLIENT_GONE\n");
        fflush(stdout);
        wl_display_terminate(g.display);
    }
}
static void client_created(struct wl_listener *listener, void *data) {
    struct wl_client *client = data;
    g.client_count++;
    g.had_client = 1;
    printf("CLIENT_CONNECTED count=%d\n", g.client_count);
    fflush(stdout);
    struct wl_listener *dl = calloc(1, sizeof(*dl));
    if (dl) {
        dl->notify = client_destroyed;
        wl_client_add_destroy_listener(client, dl);
    }
}

/* ====================================================================== */
/* Setup                                                                  */
/* ====================================================================== */

/* Build the wl_keyboard keymap: compile the self-contained TEXT_V1 map
 * through libxkbcommon (proving the port works + normalizing it), then
 * write the canonical string to a mappable fd for wl_keyboard.keymap. */
static int setup_keymap(void) {
    static const char KEYMAP[] =
        "xkb_keymap {\n"
        "  xkb_keycodes \"kandelo\" {\n"
        "    minimum = 8;\n"
        "    maximum = 255;\n"
        "    <LFSH> = 50;\n"
        "    <AC01> = 38;\n"
        "    <ESC>  = 9;\n"
        "  };\n"
        "  xkb_types \"kandelo\" {\n"
        "    virtual_modifiers NumLock;\n"
        "    type \"ONE_LEVEL\" {\n"
        "      modifiers = none;\n"
        "      level_name[Level1] = \"Any\";\n"
        "    };\n"
        "    type \"TWO_LEVEL\" {\n"
        "      modifiers = Shift;\n"
        "      map[Shift] = Level2;\n"
        "      level_name[Level1] = \"Base\";\n"
        "      level_name[Level2] = \"Shift\";\n"
        "    };\n"
        "  };\n"
        "  xkb_compat \"kandelo\" {\n"
        "    interpret Shift_L+AnyOfOrNone(all) {\n"
        "      action = SetMods(modifiers=Shift);\n"
        "    };\n"
        "  };\n"
        "  xkb_symbols \"kandelo\" {\n"
        "    key <ESC>  { [ Escape ] };\n"
        "    key <LFSH> { [ Shift_L ] };\n"
        "    key <AC01> { type=\"TWO_LEVEL\", [ a, A ] };\n"
        "    modifier_map Shift { <LFSH> };\n"
        "  };\n"
        "};\n";

    struct xkb_context *ctx =
        xkb_context_new(XKB_CONTEXT_NO_DEFAULT_INCLUDES);
    if (!ctx) return -1;
    struct xkb_keymap *keymap = xkb_keymap_new_from_string(
        ctx, KEYMAP, XKB_KEYMAP_FORMAT_TEXT_V1, XKB_KEYMAP_COMPILE_NO_FLAGS);
    if (!keymap) { xkb_context_unref(ctx); return -1; }
    char *str = xkb_keymap_get_as_string(keymap, XKB_KEYMAP_FORMAT_TEXT_V1);
    if (!str) { xkb_keymap_unref(keymap); xkb_context_unref(ctx); return -1; }

    size_t len = strlen(str) + 1;   /* clients expect a NUL-terminated map */
    /* A regular file gives the client a mappable fd. /run is a scratch
     * mount, fine for an ephemeral keymap. */
    int fd = open(WL_KEYMAP_PATH, O_RDWR | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) {
        perror("open keymap");
        free(str); xkb_keymap_unref(keymap); xkb_context_unref(ctx);
        return -1;
    }
    if (write(fd, str, len) != (ssize_t)len) {
        perror("write keymap");
        close(fd); free(str); xkb_keymap_unref(keymap); xkb_context_unref(ctx);
        return -1;
    }
    g.xkb_keymap_fd = fd;
    g.xkb_keymap_size = (uint32_t)len;
    free(str);
    xkb_keymap_unref(keymap);
    xkb_context_unref(ctx);
    return 0;
}

static int setup_drm(void) {
    g.card_fd = open("/dev/dri/card0", O_RDWR | O_CLOEXEC);
    if (g.card_fd < 0) { perror("open card0"); return -1; }
    if (drmSetMaster(g.card_fd) < 0) { perror("drmSetMaster"); return -1; }

    drmModeResPtr res = drmModeGetResources(g.card_fd);
    if (!res || res->count_crtcs < 1 || res->count_connectors < 1) {
        fprintf(stderr, "no crtc/connector\n");
        return -1;
    }
    g.crtc_id = res->crtcs[0];
    g.connector_id = res->connectors[0];
    drmModeConnectorPtr conn = drmModeGetConnector(g.card_fd, g.connector_id);
    if (!conn || conn->count_modes < 1) { fprintf(stderr, "no modes\n"); return -1; }
    g.mode = conn->modes[0];
    g.width = g.mode.hdisplay;
    g.height = g.mode.vdisplay;
    drmModeFreeConnector(conn);
    drmModeFreeResources(res);

    /* Scanout bos live on card0 directly: CREATE_DUMB handles from card0
     * are valid for ADDFB2 on card0, so no PRIME round-trip is needed. */
    g.gbm = gbm_create_device(g.card_fd);
    if (!g.gbm) { fprintf(stderr, "gbm_create_device\n"); return -1; }
    g.gbm_surface = gbm_surface_create(
        g.gbm, g.width, g.height, GBM_FORMAT_XRGB8888,
        GBM_BO_USE_SCANOUT | GBM_BO_USE_LINEAR);
    if (!g.gbm_surface) { fprintf(stderr, "gbm_surface_create\n"); return -1; }
    return 0;
}

static int setup_input(void) {
    g.li = libinput_path_create_context(&li_interface, NULL);
    if (!g.li) { fprintf(stderr, "libinput_path_create_context\n"); return -1; }
    /* Best-effort: a missing node is not fatal (headless CI may lack one),
     * but the virtual keyboard/pointer always exist under our kernel. */
    libinput_path_add_device(g.li, "/dev/input/event0");  /* keyboard */
    libinput_path_add_device(g.li, "/dev/input/event1");  /* pointer  */
    libinput_dispatch(g.li);
    /* Drain the initial DEVICE_ADDED events. */
    struct libinput_event *ev;
    while ((ev = libinput_get_event(g.li)) != NULL)
        libinput_event_destroy(ev);
    g.cursor_x = g.width / 2.0;
    g.cursor_y = g.height / 2.0;
    return 0;
}

/* Bind + listen an AF_UNIX socket at the fixed Wayland path and hand it to
 * libwayland. We manage the socket ourselves (rather than
 * wl_display_add_socket, which derives the path from XDG_RUNTIME_DIR) so
 * the path is deterministic for the client. */
static int setup_socket(void) {
    unlink(WL_SOCKET_PATH);              /* clear a stale socket */

    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) { perror("socket"); return -1; }
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, WL_SOCKET_PATH, sizeof(addr.sun_path) - 1);
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("bind"); close(fd); return -1;
    }
    if (listen(fd, 8) < 0) { perror("listen"); close(fd); return -1; }
    if (wl_display_add_socket_fd(g.display, fd) < 0) {
        fprintf(stderr, "wl_display_add_socket_fd\n"); close(fd); return -1;
    }
    return 0;
}

int main(void) {
    g.display = wl_display_create();
    if (!g.display) { fprintf(stderr, "wl_display_create\n"); return 1; }
    g.loop = wl_display_get_event_loop(g.display);

    if (setup_drm() != 0) return 1;
    if (setup_keymap() != 0) return 1;
    if (setup_input() != 0) return 1;

    /* Globals. Versions are the minimum that carry the events we send. */
    if (!wl_global_create(g.display, &wl_compositor_interface, 4, NULL,
                          compositor_bind) ||
        !wl_global_create(g.display, &wl_shm_interface, 1, NULL, shm_bind) ||
        !wl_global_create(g.display, &xdg_wm_base_interface, 1, NULL,
                          wm_base_bind) ||
        !wl_global_create(g.display, &wl_seat_interface, 1, NULL, seat_bind) ||
        !wl_global_create(g.display, &wl_output_interface, 2, NULL,
                          output_bind)) {
        fprintf(stderr, "wl_global_create failed\n");
        return 1;
    }

    /* Register the DRM fd (flip-complete events) and the libinput fd. */
    wl_event_loop_add_fd(g.loop, g.card_fd, WL_EVENT_READABLE, card_readable,
                         NULL);
    wl_event_loop_add_fd(g.loop, libinput_get_fd(g.li), WL_EVENT_READABLE,
                         libinput_readable, NULL);

    /* Notify us on every client connect so we can exit when the last one
     * leaves. */
    static struct wl_listener new_client;
    new_client.notify = client_created;
    wl_display_add_client_created_listener(g.display, &new_client);

    if (setup_socket() != 0) return 1;

    printf("COMPOSITOR_UP w=%u h=%u\n", g.width, g.height);
    fflush(stdout);

    wl_display_run(g.display);

    printf("COMPOSITOR_DONE\n");
    fflush(stdout);
    wl_display_destroy(g.display);
    return 0;
}
