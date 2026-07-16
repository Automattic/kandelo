/*
 * wlcompositor — a small but real PID-2 Wayland compositor for the
 * wasm32 POSIX kernel (DRI plan §5 PR6, extended to a floating-window
 * desktop). It is a genuine libwayland *server*: it runs libwayland's
 * wl_event_loop on the kernel's epoll, listens on an AF_UNIX socket at
 * /tmp/wayland-0, holds DRM master on card0, and drives real input from
 * the ported libinput 1.25.0 path backend. Nothing here is mocked —
 * clients speak the real wire protocol.
 *
 * v2 interface set:
 *   wl_compositor + wl_surface + wl_region
 *   wl_shm + wl_shm_pool + wl_buffer   (via a gbm prime-fd pool path)
 *   xdg_wm_base + xdg_surface + xdg_toplevel  (incl. interactive move)
 *   wl_seat + wl_keyboard (keymap + modifiers) + wl_pointer
 *   wl_output
 *
 * v2 window management (what makes this a desktop, not a fullscreen
 * blitter):
 *   - many toplevels at once, each with a position and a z-order slot;
 *     new windows are placed by an app_id rule table (wlterm / wlclock /
 *     wlpaint get demo-layout slots) with a cascade fallback;
 *   - compositing paints a pre-rendered wallpaper, then every mapped
 *     surface bottom→top and a focus border on the active window. No
 *     software cursor: the embedder (browser Modeset pane, remote
 *     viewer) shows the host pointer, which the input bridge maps
 *     absolutely onto the desktop;
 *   - pointer focus follows the topmost surface under the cursor
 *     (enter/leave with surface-local coordinates); a button press
 *     raises the window under the cursor and moves keyboard focus to it
 *     (click-to-focus);
 *   - input events are routed ONLY to seat resources owned by the
 *     focused surface's client — never broadcast across clients (a
 *     cross-client wl_keyboard.enter is a protocol error libwayland
 *     aborts on);
 *   - xdg_toplevel.move starts an interactive move grab: while the
 *     button is held the compositor drags the window and withholds
 *     pointer events from clients; release ends the grab. Kandelo apps
 *     use client-side decoration (libkwl titlebars) and request the
 *     move themselves — exactly the Wayland CSD contract.
 *
 * Clients are the CPU (wl_shm) tier: a client renders ARGB/XRGB pixels
 * into a gbm dumb-bo and the bo's prime-fd rides SCM_RIGHTS to us as the
 * wl_shm pool fd. COMPOSITING is GPU-first with a CPU fallback:
 *
 *   - GPU path (browser hosts with WebGL2): a GLES3 context on
 *     /dev/dri/renderD128 renders the frame — client bos are imported as
 *     textures via the WPK dmabuf extension (wpkEglImportDmabufHandle +
 *     wpkEglBindBoTexture; the host uploads pixels straight from the
 *     bo's shared storage, no cmdbuf marshalling) and composited as
 *     textured quads. The frame is encoded in one cmdbuf flush, so the
 *     display canvas transitions atomically between complete frames.
 *     KMS PAGE_FLIPs still pace the frame clock (frame callbacks, flip
 *     counters); only pixel production moves to the GPU. WLC_NO_GPU=1
 *     forces the CPU path (a manual debug escape hatch, documented in
 *     docs/browser-support.md).
 *
 *   - CPU path (Node smokes, hosts without WebGL2, or GPU init/runtime
 *     failure): the committed buffers are CPU-blitted into a scanout
 *     gbm_bo exactly as before. GPU availability is probed at startup by
 *     compiling the compositor shader — sync GL queries fail cleanly on
 *     headless hosts. One-shot WLC_RENDERER marker reports the outcome.
 *
 * Clients are paced with wl_surface.frame callbacks fired on flip
 * completion. ESC is forwarded, never special-cased.
 *
 * The process exits 0 once its last client disconnects, so the smoke
 * gates (host/test/wlcompositor-smoke.test.ts and friends) can spawn
 * compositor + client(s) and observe a clean shutdown.
 */
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include <wayland-server.h>
#include <wayland-server-protocol.h>
#include "xdg-shell-server-protocol.h"
#include "linux-dmabuf-v1-server-protocol.h"

#include <xkbcommon/xkbcommon.h>
#include <xkbcommon/xkbcommon-names.h>
#include <xkbcommon/xkbcommon-keysyms.h>
#include <libinput.h>

#include <gbm.h>
#include <xf86drm.h>
#include <xf86drmMode.h>
#include <drm/drm_fourcc.h>

#include <EGL/egl.h>
#include <GLES2/gl2.h>

#include <wpkdraw/wpkdraw.h>
#include <wpkdraw/wpkfont.h>

/* WPK dmabuf-import EGL extension (libc/glue/libegl_stub.c): import a
 * prime-fd on the EGL session's render fd and bind the bo as a texture
 * in the current context. Re-binding refreshes the texture pixels from
 * the producer's latest commit. */
extern unsigned wpkEglImportDmabufHandle(EGLDisplay dpy, int prime_fd);
extern unsigned wpkEglBindBoTexture(EGLDisplay dpy, unsigned bo_handle,
                                    unsigned gl_target);
extern void wpkEglCloseBoHandle(EGLDisplay dpy, unsigned bo_handle);

/* The Wayland runtime dir. / is a read-only rootfs and /var/run is a
 * root-owned 0755 scratch mount, so under this kernel the only dir writable
 * by any uid is /tmp (mode 1777) — it plays the XDG_RUNTIME_DIR role here. */
#define WL_SOCKET_PATH "/tmp/wayland-0"
/* The hyprctl analog: a control + event socket alongside the wayland one.
 * kwlctl (programs/wlcompositor/kwlctl.c) and the Tier-1 bar speak to it. */
#define KWLCTL_SOCKET_PATH "/tmp/kwlctl-0"
#define MAX_KWLCTL_CONNS 16
#define WL_KEYMAP_PATH "/tmp/wlcompositor-keymap.xkb"
#define MAX_INPUT_RES  16     /* keyboard/pointer resources we track */
#define MAX_FRAME_CB   32     /* pending frame callbacks per surface */
#define MAX_SURFACES   16     /* mapped toplevels in the z-order list */
#define FOCUS_COLOR    0xff4f8fdfu  /* accent ring, GPU and CPU paths */
#define N_WORKSPACES   9      /* SUPER+1..9, Hyprland's 1-based workspaces */

/* The config path, hyprland.conf-shaped subset. Absent = generic defaults
 * (install_default_binds); WLC_CONFIG overrides for tests. */
#define WLC_CONFIG_PATH "/etc/kandelo/wlcompositor.conf"
#define MAX_BINDS 64

/* Modifier bits used by the keybind engine (mapped from xkb mod state). */
#define MOD_SUPER 1
#define MOD_SHIFT 2
#define MOD_CTRL  4

enum bind_action {
    ACT_EXEC, ACT_WORKSPACE, ACT_MOVE_TO_WS, ACT_KILL,
    ACT_CYCLE_NEXT, ACT_CYCLE_PREV,
};

/* One `bind = MODS, KEY, DISPATCHER, ARGS` rule. sym is the BASE-level keysym
 * (shift-independent) so `SUPER SHIFT, 1` matches the same key as `SUPER, 1`. */
struct keybind {
    uint32_t mods;         /* MOD_* bitmask; matched exactly */
    xkb_keysym_t sym;
    int action;
    int arg;               /* workspace number for workspace/movetoworkspace */
    char param[64];        /* command line for exec */
};

/* ---- surface state ----------------------------------------------------- */

/* A wl_surface plus the double-buffered commit state we care about: the
 * currently-attached wl_buffer (retained until the next commit so an
 * occluded window can be repainted when the desktop changes around it)
 * and the frame callbacks awaiting the next flip. */
struct surface {
    struct wl_resource *resource;       /* the wl_surface */
    struct wl_client *client;
    struct wl_resource *pending_buffer; /* set by attach, consumed by commit */
    struct wl_resource *buffer;         /* committed, retained for repaints */
    struct wl_resource *xdg_surface;    /* xdg_surface wrapping this surface */
    struct wl_resource *xdg_toplevel;
    char app_id[32];
    int32_t x, y;                       /* top-left on the output */
    int32_t w, h;                       /* committed buffer dims */
    int workspace;                      /* 1..N_WORKSPACES; 0 until first map */
    int mapped;                         /* has a committed buffer been shown */
    int placed;                         /* position assigned at first map */
    struct wl_resource *frame_cbs[MAX_FRAME_CB];
    int n_frame_cbs;
};

/* ---- wl_shm pool / buffer (custom, gbm-backed) ------------------------- */

/* libwayland's built-in wl_shm mmaps the client's pool fd directly, but on
 * this kernel a plain file/memfd mmap is NOT shared across processes — only
 * the DRI bo registry is (host SharedArrayBuffer). So the client backs its
 * pool with a renderD128 dumb-bo and passes its prime-fd; we import that
 * prime-fd via gbm and map it, aliasing the same shared bytes. This is the
 * "gbm_bo_import path for wl_shm" the plan names (§8.1). We handle the
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
    struct gbm_bo *bo;      /* lazily imported on first composite (CPU path) */
    void *map_data;
    uint32_t *pixels;       /* shared mapping of the client's bytes */
    uint32_t map_stride_px;
    /* GPU path: the bo imported on the EGL fd + its texture. gl_dirty is
     * set on every commit of this buffer so the next GL repaint rebinds
     * (= re-uploads) only surfaces whose content actually changed. */
    unsigned egl_bo_handle;
    unsigned gl_tex;
    int gl_dirty;
};

/* ---- compositor singleton ---------------------------------------------- */

struct kwlctl_conn;   /* one control-socket connection (defined with the IPC) */

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

    /* Pre-rendered desktop background (width × height, tightly packed). */
    uint32_t *wallpaper;

    /* Input. */
    struct libinput *li;
    uint32_t xkb_keymap_size;
    struct xkb_state *xkb_state;   /* compositor-side modifier tracking */
    uint32_t sent_mods_depressed, sent_mods_latched, sent_mods_locked,
             sent_group;
    double cursor_x, cursor_y;
    int buttons_down;

    /* Window management. */
    struct surface *zorder[MAX_SURFACES];  /* bottom → top */
    int n_surfaces;
    /* Every live surface, mapped or not. buffer_resource_destroy must
     * clear buffer references on surfaces that never mapped (attach →
     * wl_buffer.destroy → commit is protocol-legal) and those are absent
     * from zorder. */
    struct surface *all_surfaces[MAX_SURFACES];
    int n_all_surfaces;
    struct surface *kbd_focus;
    struct surface *ptr_focus;

    /* Interactive move grab (xdg_toplevel.move). */
    struct surface *grab;
    double grab_dx, grab_dy;

    /* Layout policy (enum layout_mode); FLOATING unless WLC_LAYOUT overrides. */
    int layout;

    /* The visible workspace (1..N_WORKSPACES). Surfaces on other workspaces
     * stay mapped but are excluded from compositing, input, and tiling. */
    int active_ws;

    /* kwlctl control clients that issued --listen; they receive the
     * `event>>data` stream (Hyprland socket2 format). NULL = free slot. */
    struct kwlctl_conn *listeners[MAX_KWLCTL_CONNS];

    /* Config-driven keybinds (install_default_binds or WLC_CONFIG_PATH). */
    struct keybind binds[MAX_BINDS];
    int n_binds;

    /* Bound seat resources (across all clients; routed per-client). */
    struct wl_resource *keyboards[MAX_INPUT_RES];
    struct wl_resource *pointers[MAX_INPUT_RES];

    int client_count;
    int had_client;   /* so we only exit after a client has actually connected */
    int repaint_needed;
    int in_input_batch; /* draining libinput events; defer repaints to the end */
    int sampled;      /* printed the one-shot composite sample */
};

static struct compositor g;

/* ---- GPU compositing state (GLES via renderD128) ----------------------- */

static struct {
    int active;                 /* GL probed OK; repaints render on the GPU */
    EGLDisplay dpy;
    EGLContext ctx;
    EGLSurface srf;
    GLuint prog;
    GLint loc_rect;             /* vec4 NDC x0,y0(top),x1,y1(bottom) */
    GLint loc_use_tex;          /* 1 = sample u_tex, 0 = flat u_color */
    GLint loc_color;
    unsigned wallpaper_tex;
} glc;

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

static void schedule_repaint(void);
static void kbd_set_focus(struct surface *s);
static void ptr_refresh_focus(void);
static void kwlctl_emit(const char *fmt, ...);
static void kwlctl_exec(char *args);

/* A surface participates in compositing, input, and tiling only when it is
 * mapped AND on the active workspace. */
static int surface_visible(const struct surface *s) {
    return s->mapped && s->workspace == g.active_ws;
}

/* Topmost mapped surface on workspace `ws` (its remembered focus, since
 * focusing raises), or NULL. */
static struct surface *topmost_on_ws(int ws) {
    for (int i = g.n_surfaces - 1; i >= 0; i--)
        if (g.zorder[i]->mapped && g.zorder[i]->workspace == ws)
            return g.zorder[i];
    return NULL;
}

/* ---- z-order helpers ---------------------------------------------------- */

static void zorder_add(struct surface *s) {
    if (g.n_surfaces < MAX_SURFACES)
        g.zorder[g.n_surfaces++] = s;
}
static void zorder_remove(struct surface *s) {
    int i = 0;
    while (i < g.n_surfaces && g.zorder[i] != s) i++;
    if (i == g.n_surfaces) return;
    for (; i + 1 < g.n_surfaces; i++) g.zorder[i] = g.zorder[i + 1];
    g.n_surfaces--;
}
static void zorder_raise(struct surface *s) {
    if (g.n_surfaces && g.zorder[g.n_surfaces - 1] == s) return;
    zorder_remove(s);
    zorder_add(s);
    schedule_repaint();
}

/* Topmost mapped surface containing the output-space point, or NULL. */
static struct surface *surface_at(double x, double y) {
    for (int i = g.n_surfaces - 1; i >= 0; i--) {
        struct surface *s = g.zorder[i];
        if (!surface_visible(s)) continue;
        if (x >= s->x && x < s->x + s->w && y >= s->y && y < s->y + s->h)
            return s;
    }
    return NULL;
}

/* ---- window placement --------------------------------------------------- */

/* Demo-layout slots by app_id, cascade fallback. Placement policy is the
 * compositor's job in Wayland (clients cannot position themselves); a rule
 * table keyed on app_id is the same mechanism real WMs use for window
 * rules. x ≥ 0 anchors to the LEFT edge; x < 0 anchors to the RIGHT edge
 * (window's left edge at width + x). The mode width follows the host
 * display's aspect ratio (1440..3840 at 1080 tall), so edge anchoring
 * spreads the demo across the full desktop; at the historical 1920-wide
 * mode the resolved coordinates are exactly the original fixed layout
 * (wlclock 1240, wlpaint 1080). All results are clamped, so narrow modes
 * still get sane spots. */
static const struct { const char *app_id; int x, y; } placement_rules[] = {
    { "wlterm",           90, 120 },
    { "wlclock", 1240 - 1920, 110 },   /* width - 680 */
    { "wlpaint", 1080 - 1920, 560 },   /* width - 840 */
};

static void place_surface(struct surface *s) {
    static int cascade;
    int x = -1, y = -1;
    for (size_t i = 0; i < sizeof(placement_rules) / sizeof(placement_rules[0]); i++) {
        if (strcmp(s->app_id, placement_rules[i].app_id) == 0) {
            x = placement_rules[i].x;
            y = placement_rules[i].y;
            /* Right-anchored rule: resolve against the live mode width.
             * Minimum mode width is 1440, so resolved x stays ≥ 600 and
             * never falls through to the cascade branch below. */
            if (x < 0) x += (int)g.width;
            break;
        }
    }
    if (x < 0) {
        x = 160 + (cascade % 5) * 72;
        y = 120 + (cascade % 5) * 56;
        cascade++;
    }
    if (x + s->w > (int)g.width) x = (int)g.width - s->w - 16;
    if (y + s->h > (int)g.height) y = (int)g.height - s->h - 16;
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    s->x = x;
    s->y = y;
    s->placed = 1;
}

/* ---- tiling layout ------------------------------------------------------ */

/* FLOATING (default, zero-initialised) keeps the app_id placement rules that
 * /?demo=wayland depends on. DWINDLE dictates geometry to clients: the desktop
 * becomes the tiling mode of the same compositor. Selected by WLC_LAYOUT. */
enum layout_mode { LAYOUT_FLOATING = 0, LAYOUT_DWINDLE };

struct geom { int x, y, w, h; };

/* Gaps in output pixels. OUTER insets the whole tiling area from the screen
 * edge; INNER separates adjacent windows. Hardcoded for v1 — PR17 makes them
 * theme-driven. */
#define TILE_GAP_OUTER 12
#define TILE_GAP_INNER 8

/* Pure dwindle tiler: partition `area` among `n` windows, recursively
 * splitting the remaining region along its LONGER side (Hyprland's default).
 * Window i takes the near half of the i-th split; the last window takes the
 * final remainder. It reads nothing but its arguments, so the smoke gate can
 * predict the exact partition and compare against the emitted geometry. */
static void compute_tiling(struct geom area, int n, struct geom *out) {
    if (n <= 0) return;
    area.x += TILE_GAP_OUTER;
    area.y += TILE_GAP_OUTER;
    area.w -= 2 * TILE_GAP_OUTER;
    area.h -= 2 * TILE_GAP_OUTER;
    if (area.w < 1) area.w = 1;
    if (area.h < 1) area.h = 1;

    struct geom region = area;
    for (int i = 0; i < n; i++) {
        if (i == n - 1) { out[i] = region; break; }
        struct geom near = region, rest = region;
        if (region.w >= region.h) {          /* wider than tall: split L|R */
            int half = (region.w - TILE_GAP_INNER) / 2;
            if (half < 1) half = 1;
            near.w = half;
            rest.x = region.x + half + TILE_GAP_INNER;
            rest.w = region.w - half - TILE_GAP_INNER;
        } else {                             /* taller than wide: split T/B */
            int half = (region.h - TILE_GAP_INNER) / 2;
            if (half < 1) half = 1;
            near.h = half;
            rest.y = region.y + half + TILE_GAP_INNER;
            rest.h = region.h - half - TILE_GAP_INNER;
        }
        out[i] = near;
        region = rest;
    }
}

/* Recompute geometry for every mapped toplevel (in map order = z-order) and
 * push it to each client through the xdg configure path. A no-op in FLOATING
 * mode, so the app_id placement path is untouched. Emits one TILE marker per
 * window for the smoke gate to verify the partition. */
static void retile(void) {
    if (g.layout == LAYOUT_FLOATING) return;

    struct surface *tiled[MAX_SURFACES];
    int n = 0;
    for (int i = 0; i < g.n_surfaces; i++)
        if (surface_visible(g.zorder[i])) tiled[n++] = g.zorder[i];
    if (n == 0) return;

    struct geom geoms[MAX_SURFACES];
    struct geom area = { 0, 0, (int)g.width, (int)g.height };
    compute_tiling(area, n, geoms);

    for (int i = 0; i < n; i++) {
        struct surface *s = tiled[i];
        s->x = geoms[i].x;
        s->y = geoms[i].y;
        s->w = geoms[i].w;
        s->h = geoms[i].h;
        s->placed = 1;
        /* Dictate the tile size to the client. The states array carries only
         * ACTIVATED for now; TILED_* awaits the xdg-shell v2 bump that lands
         * with server-side decoration (PR14e). */
        if (s->xdg_toplevel && s->xdg_surface) {
            struct wl_array states;
            wl_array_init(&states);
            uint32_t *st = wl_array_add(&states, sizeof(uint32_t));
            if (st) *st = XDG_TOPLEVEL_STATE_ACTIVATED;
            xdg_toplevel_send_configure(s->xdg_toplevel, s->w, s->h, &states);
            wl_array_release(&states);
            xdg_surface_send_configure(s->xdg_surface,
                                       wl_display_next_serial(g.display));
        }
        printf("TILE n=%d i=%d x=%d y=%d w=%d h=%d\n",
               n, i, s->x, s->y, s->w, s->h);
    }
    fflush(stdout);
    schedule_repaint();
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
static void surface_commit(struct wl_client *c, struct wl_resource *r) {
    struct surface *s = wl_resource_get_user_data(r);
    if (!s->pending_buffer) { schedule_repaint(); return; }

    /* Apply double-buffered state: the pending attach becomes current. The
     * previous buffer is released now — its client only reuses it after
     * this commit's frame callback, by which time we composite from the
     * new one. */
    if (s->buffer && s->buffer != s->pending_buffer)
        wl_buffer_send_release(s->buffer);
    s->buffer = s->pending_buffer;
    s->pending_buffer = NULL;

    struct shm_buffer *b = wl_resource_get_user_data(s->buffer);
    if (b) {
        s->w = b->width;
        s->h = b->height;
        b->gl_dirty = 1;   /* GPU path re-uploads this buffer's texture */
    }

    if (!s->mapped) {
        s->mapped = 1;
        if (!s->workspace) s->workspace = g.active_ws;   /* opens on the visible ws */
        /* Tiling dictates geometry for every window in retile(); only the
         * floating desktop places individually by app_id. */
        if (g.layout == LAYOUT_FLOATING && !s->placed) place_surface(s);
        zorder_raise(s);
        /* A newly mapped window takes keyboard focus (and pointer focus if
         * the cursor happens to be over it). */
        kbd_set_focus(s);
        ptr_refresh_focus();
        retile();   /* no-op when floating */
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
    for (int i = 0; i < g.n_all_surfaces; i++) {
        if (g.all_surfaces[i] != s) continue;
        g.all_surfaces[i] = g.all_surfaces[--g.n_all_surfaces];
        break;
    }
    zorder_remove(s);
    if (g.kbd_focus == s) {
        g.kbd_focus = NULL;
        /* Hand focus to the new top window on the visible workspace, if any. */
        kbd_set_focus(topmost_on_ws(g.active_ws));
    }
    if (g.ptr_focus == s) g.ptr_focus = NULL;
    if (g.grab == s) g.grab = NULL;
    /* Clearing our references avoids a dangling send after destroy; the
     * callbacks themselves are owned by the client and freed with it. */
    s->n_frame_cbs = 0;
    free(s);
    /* A closed window frees its slice back to the remaining tiles. */
    retile();   /* no-op when floating */
    schedule_repaint();
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
    /* Surfaces retain attached/committed buffers; drop every reference to
     * this one — including on never-mapped surfaces, which aren't in
     * zorder — so no later commit or repaint touches a destroyed
     * resource. */
    for (int i = 0; i < g.n_all_surfaces; i++) {
        if (g.all_surfaces[i]->buffer == r) g.all_surfaces[i]->buffer = NULL;
        if (g.all_surfaces[i]->pending_buffer == r)
            g.all_surfaces[i]->pending_buffer = NULL;
    }
    if (b->bo) {
        if (b->map_data) gbm_bo_unmap(b->bo, b->map_data);
        gbm_bo_destroy(b->bo);
    }
    /* GEM_CLOSE on the EGL fd; the host deletes the bound WebGLTexture
     * when the bo's refcount hits zero (the bo owns the texture). */
    if (b->egl_bo_handle) wpkEglCloseBoHandle(glc.dpy, b->egl_bo_handle);
    if (--b->pool->refcount == 0) shm_pool_free(b->pool);
    free(b);
}

static void pool_create_buffer(struct wl_client *client, struct wl_resource *r,
                               uint32_t id, int32_t offset, int32_t width,
                               int32_t height, int32_t stride,
                               uint32_t format) {
    struct shm_pool *p = wl_resource_get_user_data(r);
    if (offset != 0) {   /* one buffer at the base of the pool */
        wl_resource_post_error(r, WL_SHM_ERROR_INVALID_STRIDE,
                               "compositor supports only offset 0");
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
/* zwp_linux_dmabuf_v1 (PR11)                                             */
/* ====================================================================== */

/* A client that renders with GL hands us its frame as a dmabuf (a prime-fd
 * on a renderD128 bo) instead of a wl_shm pool. Sampling is identical to
 * the shm path — both wrap a prime-fd + dims — so a dmabuf wl_buffer reuses
 * struct shm_buffer, backed by a single-plane pool over the dmabuf fd. For
 * a GPU-tier bo the downstream BIND_FOREIGN_TEXTURE is zero-copy (PR10).
 *
 * We advertise version 3 (format + modifier events), LINEAR only — the one
 * layout the GPU tier and our gbm_bo_import path handle. Feedback (v4+) is
 * intentionally not offered. */

struct dmabuf_params {
    int fd;               /* plane-0 fd, dup'd from the client; -1 until add */
    int32_t offset, stride;
    int has_plane;        /* add() recorded plane 0 */
    int used;             /* create/create_immed consumes the params once */
};

/* Turn finished params into a wl_buffer-backing shm_buffer, transferring
 * ownership of the plane fd to a fresh single-ref pool. On success *err=0;
 * on a params error returns NULL with *err set to the code to report; on OOM
 * returns NULL with *err=0 after posting no_memory. */
static struct shm_buffer *dmabuf_make_buffer(struct wl_client *c,
                                             struct dmabuf_params *p,
                                             int32_t width, int32_t height,
                                             uint32_t format, uint32_t *err) {
    *err = 0;
    if (!p->has_plane) {
        *err = ZWP_LINUX_BUFFER_PARAMS_V1_ERROR_INCOMPLETE;
        return NULL;
    }
    if (width <= 0 || height <= 0) {
        *err = ZWP_LINUX_BUFFER_PARAMS_V1_ERROR_INVALID_DIMENSIONS;
        return NULL;
    }
    if (format != DRM_FORMAT_XRGB8888 && format != DRM_FORMAT_ARGB8888) {
        *err = ZWP_LINUX_BUFFER_PARAMS_V1_ERROR_INVALID_FORMAT;
        return NULL;
    }
    struct shm_pool *pool = calloc(1, sizeof(*pool));
    struct shm_buffer *b = calloc(1, sizeof(*b));
    if (!pool || !b) {
        free(pool);
        free(b);
        wl_client_post_no_memory(c);
        return NULL;
    }
    pool->fd = p->fd;
    pool->size = p->stride * height;
    pool->refcount = 1;
    b->pool = pool;
    b->offset = p->offset;
    b->width = width;
    b->height = height;
    b->stride = p->stride;
    b->format = format;
    p->fd = -1;   /* the pool owns the fd now */
    return b;
}

/* Free a built-but-unpublished buffer (wl_resource_create failed after the
 * fd was already transferred into the pool). */
static void dmabuf_discard_buffer(struct shm_buffer *b) {
    if (--b->pool->refcount == 0) shm_pool_free(b->pool);
    free(b);
}

static void dmabuf_params_add(struct wl_client *c, struct wl_resource *r,
                              int32_t fd, uint32_t plane_idx, uint32_t offset,
                              uint32_t stride, uint32_t modifier_hi,
                              uint32_t modifier_lo) {
    struct dmabuf_params *p = wl_resource_get_user_data(r);
    if (p->used) {
        wl_resource_post_error(r, ZWP_LINUX_BUFFER_PARAMS_V1_ERROR_ALREADY_USED,
                               "params already used");
        close(fd);
        return;
    }
    if (plane_idx != 0) {
        wl_resource_post_error(r, ZWP_LINUX_BUFFER_PARAMS_V1_ERROR_PLANE_IDX,
                               "only plane 0 is supported");
        close(fd);
        return;
    }
    if (p->has_plane) {
        wl_resource_post_error(r, ZWP_LINUX_BUFFER_PARAMS_V1_ERROR_PLANE_SET,
                               "plane 0 already set");
        close(fd);
        return;
    }
    /* LINEAR only: the GPU tier keeps a LINEAR-equivalent layout and the CPU
     * fallback maps the fd as linear bytes. */
    if ((((uint64_t)modifier_hi << 32) | modifier_lo) != DRM_FORMAT_MOD_LINEAR) {
        wl_resource_post_error(r, ZWP_LINUX_BUFFER_PARAMS_V1_ERROR_INVALID_FORMAT,
                               "only DRM_FORMAT_MOD_LINEAR is supported");
        close(fd);
        return;
    }
    p->fd = fd;
    p->offset = (int32_t)offset;
    p->stride = (int32_t)stride;
    p->has_plane = 1;
}

static void dmabuf_params_create(struct wl_client *c, struct wl_resource *r,
                                 int32_t width, int32_t height, uint32_t format,
                                 uint32_t flags) {
    /* flags (y_invert/interlaced/bottom_first) don't apply: our producers
     * render top-left-origin into a progressive bo. */
    struct dmabuf_params *p = wl_resource_get_user_data(r);
    if (p->used) {
        wl_resource_post_error(r, ZWP_LINUX_BUFFER_PARAMS_V1_ERROR_ALREADY_USED,
                               "params already used");
        return;
    }
    p->used = 1;
    uint32_t err = 0;
    struct shm_buffer *b = dmabuf_make_buffer(c, p, width, height, format, &err);
    if (!b) {
        if (err) zwp_linux_buffer_params_v1_send_failed(r);
        return;
    }
    struct wl_resource *br = wl_resource_create(c, &wl_buffer_interface, 1, 0);
    if (!br) {
        dmabuf_discard_buffer(b);
        wl_client_post_no_memory(c);
        return;
    }
    wl_resource_set_implementation(br, &buffer_impl, b, buffer_resource_destroy);
    zwp_linux_buffer_params_v1_send_created(r, br);
}

static void dmabuf_params_create_immed(struct wl_client *c,
                                       struct wl_resource *r, uint32_t buffer_id,
                                       int32_t width, int32_t height,
                                       uint32_t format, uint32_t flags) {
    struct dmabuf_params *p = wl_resource_get_user_data(r);
    if (p->used) {
        wl_resource_post_error(r, ZWP_LINUX_BUFFER_PARAMS_V1_ERROR_ALREADY_USED,
                               "params already used");
        return;
    }
    p->used = 1;
    uint32_t err = 0;
    struct shm_buffer *b = dmabuf_make_buffer(c, p, width, height, format, &err);
    if (!b) {
        /* create_immed reports failure as a fatal protocol error (it has no
         * 'failed' event — the client committed to the new_id). */
        if (err) wl_resource_post_error(r, err, "invalid dmabuf params");
        return;
    }
    struct wl_resource *br =
        wl_resource_create(c, &wl_buffer_interface, 1, buffer_id);
    if (!br) {
        dmabuf_discard_buffer(b);
        wl_client_post_no_memory(c);
        return;
    }
    wl_resource_set_implementation(br, &buffer_impl, b, buffer_resource_destroy);
}

static void dmabuf_params_destroy_req(struct wl_client *c,
                                      struct wl_resource *r) {
    wl_resource_destroy(r);
}
static const struct zwp_linux_buffer_params_v1_interface dmabuf_params_impl = {
    .destroy = dmabuf_params_destroy_req,
    .add = dmabuf_params_add,
    .create = dmabuf_params_create,
    .create_immed = dmabuf_params_create_immed,
};
static void dmabuf_params_resource_destroy(struct wl_resource *r) {
    struct dmabuf_params *p = wl_resource_get_user_data(r);
    if (!p) return;
    if (p->fd >= 0) close(p->fd);   /* a plane added but never consumed */
    free(p);
}

static void dmabuf_create_params(struct wl_client *c, struct wl_resource *r,
                                 uint32_t params_id) {
    struct dmabuf_params *p = calloc(1, sizeof(*p));
    if (!p) { wl_client_post_no_memory(c); return; }
    p->fd = -1;
    struct wl_resource *pr = wl_resource_create(
        c, &zwp_linux_buffer_params_v1_interface, wl_resource_get_version(r),
        params_id);
    if (!pr) { free(p); wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(pr, &dmabuf_params_impl, p,
                                   dmabuf_params_resource_destroy);
}
static void dmabuf_destroy_req(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}

/* Feedback (v4+) is not advertised, so a conforming client never reaches
 * these. Hand back an inert resource rather than leaving a NULL dispatch
 * slot a malformed client could crash the compositor through. */
static void dmabuf_feedback_destroy_req(struct wl_client *c,
                                        struct wl_resource *r) {
    wl_resource_destroy(r);
}
static const struct zwp_linux_dmabuf_feedback_v1_interface dmabuf_feedback_impl = {
    .destroy = dmabuf_feedback_destroy_req,
};
static void dmabuf_get_feedback(struct wl_client *c, struct wl_resource *r,
                                uint32_t id) {
    struct wl_resource *fb = wl_resource_create(
        c, &zwp_linux_dmabuf_feedback_v1_interface, wl_resource_get_version(r),
        id);
    if (!fb) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(fb, &dmabuf_feedback_impl, NULL, NULL);
}
static void dmabuf_get_default_feedback(struct wl_client *c,
                                        struct wl_resource *r, uint32_t id) {
    dmabuf_get_feedback(c, r, id);
}
static void dmabuf_get_surface_feedback(struct wl_client *c,
                                        struct wl_resource *r, uint32_t id,
                                        struct wl_resource *surface) {
    dmabuf_get_feedback(c, r, id);
}
static const struct zwp_linux_dmabuf_v1_interface dmabuf_impl = {
    .destroy = dmabuf_destroy_req,
    .create_params = dmabuf_create_params,
    .get_default_feedback = dmabuf_get_default_feedback,
    .get_surface_feedback = dmabuf_get_surface_feedback,
};
static void dmabuf_bind(struct wl_client *c, void *data, uint32_t version,
                        uint32_t id) {
    struct wl_resource *r =
        wl_resource_create(c, &zwp_linux_dmabuf_v1_interface, version, id);
    if (!r) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(r, &dmabuf_impl, NULL, NULL);
    /* Advertise the formats the GPU tier + gbm import path handle, LINEAR
     * only. The modifier event exists since interface version 3. */
    static const uint32_t fmts[] = { DRM_FORMAT_XRGB8888, DRM_FORMAT_ARGB8888 };
    for (unsigned i = 0; i < sizeof(fmts) / sizeof(fmts[0]); i++) {
        zwp_linux_dmabuf_v1_send_format(r, fmts[i]);
        if (version >= ZWP_LINUX_DMABUF_V1_MODIFIER_SINCE_VERSION)
            zwp_linux_dmabuf_v1_send_modifier(
                r, fmts[i], (uint32_t)(DRM_FORMAT_MOD_LINEAR >> 32),
                (uint32_t)(DRM_FORMAT_MOD_LINEAR & 0xffffffffu));
    }
}

/* ====================================================================== */
/* wl_compositor                                                          */
/* ====================================================================== */

static void compositor_create_surface(struct wl_client *client,
                                      struct wl_resource *resource,
                                      uint32_t id) {
    /* Refuse rather than track partially: an untracked surface would be
     * invisible to buffer_resource_destroy's reference sweep. */
    if (g.n_all_surfaces >= MAX_SURFACES) {
        wl_client_post_no_memory(client);
        return;
    }
    struct surface *s = calloc(1, sizeof(*s));
    if (!s) { wl_client_post_no_memory(client); return; }
    s->client = client;
    s->resource = wl_resource_create(client, &wl_surface_interface,
                                     wl_resource_get_version(resource), id);
    if (!s->resource) { free(s); wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(s->resource, &surface_impl, s,
                                   surface_resource_destroy);
    g.all_surfaces[g.n_all_surfaces++] = s;
}

/* wl_region is accepted but has no compositing effect (surfaces are
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
                               const char *title) {
    /* Clients draw their own titlebars (CSD); the server has no use for
     * the title. */
}
static void toplevel_set_app_id(struct wl_client *c, struct wl_resource *r,
                                const char *app_id) {
    struct surface *s = wl_resource_get_user_data(r);
    if (s && app_id) snprintf(s->app_id, sizeof(s->app_id), "%s", app_id);
}
static void toplevel_show_window_menu(struct wl_client *c, struct wl_resource *r,
                                      struct wl_resource *seat, uint32_t serial,
                                      int32_t x, int32_t y) {}
/* The CSD move contract: the client saw a button press on its titlebar and
 * asks us to take over. Valid only while that button is still held; the
 * grab tracks the cursor until release. */
static void toplevel_move(struct wl_client *c, struct wl_resource *r,
                          struct wl_resource *seat, uint32_t serial) {
    struct surface *s = wl_resource_get_user_data(r);
    if (!s || !s->mapped || g.buttons_down <= 0) return;
    g.grab = s;
    g.grab_dx = g.cursor_x - s->x;
    g.grab_dy = g.cursor_y - s->y;
    printf("MOVE_GRAB \"%s\"\n", s->app_id);
    fflush(stdout);
    zorder_raise(s);
    /* The pointer leaves the client for the duration of the grab. */
    if (g.ptr_focus) {
        uint32_t ser = wl_display_next_serial(g.display);
        for (int i = 0; i < MAX_INPUT_RES; i++)
            if (g.pointers[i] &&
                wl_resource_get_client(g.pointers[i]) == g.ptr_focus->client)
                wl_pointer_send_leave(g.pointers[i], ser,
                                      g.ptr_focus->resource);
        g.ptr_focus = NULL;
    }
}
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
    xdg_toplevel_send_configure(tl, 0, 0, &states);
    wl_array_release(&states);
    xdg_surface_send_configure(resource, wl_display_next_serial(g.display));
}
static void xdg_surface_get_popup(struct wl_client *c, struct wl_resource *r,
                                  uint32_t id, struct wl_resource *parent,
                                  struct wl_resource *positioner) {
    /* xdg_popup is deferred to PR8; reject rather than half-implement. */
    wl_resource_post_error(r, XDG_WM_BASE_ERROR_INVALID_POPUP_PARENT,
                           "xdg_popup unsupported");
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
    /* Close the keymap fd this keyboard's send_keymap left open (stored
     * +1 so an unset user_data reads as -1). Safe now: the fd's
     * open-file description is private to this keyboard bind, and the
     * client consumed (or abandoned) the keymap long before releasing
     * the resource. */
    int fd = (int)(intptr_t)wl_resource_get_user_data(r) - 1;
    if (fd >= 0) close(fd);
}

static void pointer_set_cursor(struct wl_client *c, struct wl_resource *r,
                               uint32_t serial, struct wl_resource *surface,
                               int32_t hx, int32_t hy) {
    /* No cursor sprite is drawn (the browser host pointer already sits at
     * the mapped position), so client cursors are accepted and ignored. */
}
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

/* Hand a keyboard resource the keymap. Each send opens a FRESH fd on the
 * keymap file rather than duplicating one long-lived fd: under this kernel
 * an SCM_RIGHTS-passed fd copies the open-file description but shares the
 * host-side handle, and the receiver's close() tears that handle down under
 * every other holder (kernel limitation of file-backed fds passed over
 * SCM_RIGHTS; prime-bo fds carry a sidecar and are unaffected). A per-send
 * fd whose only long-term holder is the receiving client keeps each
 * client's copy independent. The sender-side fd must stay open until the
 * client has read the keymap (closing right after the flush would race
 * that read through the same shared handle), so it rides the keyboard
 * resource's user data and is closed in keyboard_resource_destroy. */
static void send_keymap(struct wl_resource *kbd) {
    int fd = open(WL_KEYMAP_PATH, O_RDONLY);
    if (fd < 0) { perror("open keymap"); return; }
    wl_keyboard_send_keymap(kbd, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1,
                            fd, g.xkb_keymap_size);
    wl_resource_set_user_data(kbd, (void *)(intptr_t)(fd + 1));
}

/* Current xkb modifier state, as wl_keyboard.modifiers arguments. */
static void current_mods(uint32_t *dep, uint32_t *lat, uint32_t *lock,
                         uint32_t *grp) {
    *dep = (uint32_t)xkb_state_serialize_mods(g.xkb_state,
                                              XKB_STATE_MODS_DEPRESSED);
    *lat = (uint32_t)xkb_state_serialize_mods(g.xkb_state,
                                              XKB_STATE_MODS_LATCHED);
    *lock = (uint32_t)xkb_state_serialize_mods(g.xkb_state,
                                               XKB_STATE_MODS_LOCKED);
    *grp = (uint32_t)xkb_state_serialize_layout(g.xkb_state,
                                                XKB_STATE_LAYOUT_EFFECTIVE);
}

static void send_modifiers_to(struct wl_resource *kbd, uint32_t serial) {
    uint32_t dep, lat, lock, grp;
    current_mods(&dep, &lat, &lock, &grp);
    wl_keyboard_send_modifiers(kbd, serial, dep, lat, lock, grp);
}

/* Keyboard focus: leave the old surface, enter the new one — only ever on
 * keyboard resources owned by that surface's client. Sending an enter for
 * another client's surface is a protocol error libwayland aborts on. */
static void kbd_set_focus(struct surface *s) {
    if (g.kbd_focus == s) return;
    uint32_t serial = wl_display_next_serial(g.display);
    if (g.kbd_focus) {
        for (int i = 0; i < MAX_INPUT_RES; i++)
            if (g.keyboards[i] &&
                wl_resource_get_client(g.keyboards[i]) == g.kbd_focus->client)
                wl_keyboard_send_leave(g.keyboards[i], serial,
                                       g.kbd_focus->resource);
    }
    g.kbd_focus = s;
    if (!s) return;
    struct wl_array keys;
    wl_array_init(&keys);
    for (int i = 0; i < MAX_INPUT_RES; i++) {
        if (g.keyboards[i] &&
            wl_resource_get_client(g.keyboards[i]) == s->client) {
            wl_keyboard_send_enter(g.keyboards[i], serial, s->resource, &keys);
            send_modifiers_to(g.keyboards[i], serial);
        }
    }
    wl_array_release(&keys);
    schedule_repaint();   /* focus border moved */
    kwlctl_emit("activewindow>>%s", s->app_id);
}

/* Pointer focus follows the surface under the cursor. */
static void ptr_set_focus(struct surface *s) {
    if (g.ptr_focus == s) return;
    uint32_t serial = wl_display_next_serial(g.display);
    if (g.ptr_focus) {
        for (int i = 0; i < MAX_INPUT_RES; i++)
            if (g.pointers[i] &&
                wl_resource_get_client(g.pointers[i]) == g.ptr_focus->client)
                wl_pointer_send_leave(g.pointers[i], serial,
                                      g.ptr_focus->resource);
    }
    g.ptr_focus = s;
    if (!s) return;
    wl_fixed_t lx = wl_fixed_from_double(g.cursor_x - s->x);
    wl_fixed_t ly = wl_fixed_from_double(g.cursor_y - s->y);
    for (int i = 0; i < MAX_INPUT_RES; i++)
        if (g.pointers[i] &&
            wl_resource_get_client(g.pointers[i]) == s->client)
            wl_pointer_send_enter(g.pointers[i], serial, s->resource, lx, ly);
}

static void ptr_refresh_focus(void) {
    if (g.grab) return;   /* no pointer focus during a move grab */
    ptr_set_focus(surface_at(g.cursor_x, g.cursor_y));
}

/* ---- workspaces --------------------------------------------------------- */

/* Show workspace `ws`: its surfaces become visible + tiled, the rest hide.
 * Focus restores to that workspace's topmost window (empty → no focus). */
static void switch_workspace(int ws) {
    if (ws < 1 || ws > N_WORKSPACES || ws == g.active_ws) return;
    g.active_ws = ws;
    kbd_set_focus(topmost_on_ws(ws));
    ptr_refresh_focus();
    retile();
    schedule_repaint();
    printf("WORKSPACE active=%d\n", ws);
    fflush(stdout);
    kwlctl_emit("workspace>>%d", ws);
}

/* Send the focused window to workspace `ws`; it vanishes from the current
 * view, which re-tiles around its absence, and focus falls to the next
 * window here. */
static void move_focus_to_workspace(int ws) {
    if (ws < 1 || ws > N_WORKSPACES || !g.kbd_focus) return;
    struct surface *s = g.kbd_focus;
    if (s->workspace == ws) return;
    s->workspace = ws;
    g.kbd_focus = NULL;
    kbd_set_focus(topmost_on_ws(g.active_ws));
    ptr_refresh_focus();
    retile();
    schedule_repaint();
    printf("MOVE_TO_WS \"%s\" ws=%d\n", s->app_id, ws);
    fflush(stdout);
}

static void seat_get_pointer(struct wl_client *client,
                             struct wl_resource *resource, uint32_t id) {
    struct wl_resource *p = wl_resource_create(
        client, &wl_pointer_interface, wl_resource_get_version(resource), id);
    if (!p) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(p, &pointer_impl, NULL,
                                   pointer_resource_destroy);
    slot_add(g.pointers, p);
    /* If this client's surface already holds pointer focus, enter it now. */
    if (g.ptr_focus && g.ptr_focus->client == client && g.ptr_focus->mapped)
        wl_pointer_send_enter(p, wl_display_next_serial(g.display),
                              g.ptr_focus->resource,
                              wl_fixed_from_double(g.cursor_x - g.ptr_focus->x),
                              wl_fixed_from_double(g.cursor_y - g.ptr_focus->y));
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
    if (g.kbd_focus && g.kbd_focus->client == client && g.kbd_focus->mapped) {
        uint32_t serial = wl_display_next_serial(g.display);
        struct wl_array keys;
        wl_array_init(&keys);
        wl_keyboard_send_enter(k, serial, g.kbd_focus->resource, &keys);
        wl_array_release(&keys);
        send_modifiers_to(k, serial);
    }
}
static void seat_get_touch(struct wl_client *client, struct wl_resource *resource,
                           uint32_t id) {
    /* No touch device; create an inert resource so the client's new_id
     * isn't left dangling. */
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
/* Compositing: wallpaper + surfaces → scanout bo → PAGE_FLIP             */
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
 * words (opaque compositing); rows are memcpy'd over the clipped span. */
static void blit_surface(struct surface *s, uint32_t *dst, uint32_t dst_stride_px) {
    if (!s->buffer) return;
    struct shm_buffer *b = wl_resource_get_user_data(s->buffer);
    if (!b) return;
    uint32_t src_stride_px = 0;
    uint32_t *src = shm_buffer_pixels(b, &src_stride_px);
    if (!src) return;

    int32_t x0 = s->x < 0 ? -s->x : 0;               /* first visible col */
    int32_t x1 = s->x + b->width > (int32_t)g.width  /* one past last col  */
                     ? (int32_t)g.width - s->x : b->width;
    if (x1 <= x0) return;
    for (int32_t row = 0; row < b->height; row++) {
        int32_t dy = s->y + row;
        if (dy < 0 || dy >= (int32_t)g.height) continue;
        memcpy(dst + (size_t)dy * dst_stride_px + (s->x + x0),
               src + (size_t)row * src_stride_px + x0,
               (size_t)(x1 - x0) * 4);
    }
}

/* A 2px accent border around the keyboard-focused window, so the active
 * window is visible even though decoration is client-side. */
static void draw_focus_border(struct surface *s, uint32_t *dst,
                              uint32_t stride_px) {
    const uint32_t color = FOCUS_COLOR;
    for (int e = 1; e <= 2; e++) {
        int32_t x0 = s->x - e, y0 = s->y - e;
        int32_t x1 = s->x + s->w + e - 1, y1 = s->y + s->h + e - 1;
        for (int32_t x = x0; x <= x1; x++) {
            if (x < 0 || x >= (int32_t)g.width) continue;
            if (y0 >= 0 && y0 < (int32_t)g.height)
                dst[(size_t)y0 * stride_px + x] = color;
            if (y1 >= 0 && y1 < (int32_t)g.height)
                dst[(size_t)y1 * stride_px + x] = color;
        }
        for (int32_t y = y0; y <= y1; y++) {
            if (y < 0 || y >= (int32_t)g.height) continue;
            if (x0 >= 0 && x0 < (int32_t)g.width)
                dst[(size_t)y * stride_px + x0] = color;
            if (x1 >= 0 && x1 < (int32_t)g.width)
                dst[(size_t)y * stride_px + x1] = color;
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
static void send_all_frame_callbacks(void) {
    for (int i = 0; i < g.n_surfaces; i++)
        send_frame_callbacks(g.zorder[i]);
}

/* ====================================================================== */
/* GPU compositing: GLES quads over imported client textures              */
/* ====================================================================== */

/* One quad per draw: the vertex shader expands gl_VertexID (triangle
 * strip, no VBO) across a uniform NDC rect; the fragment shader samples
 * the surface texture (with the XRGB [B,G,R,X] → RGB swizzle, exactly
 * like the host's webgl2-scanout presenter) or fills a flat color for
 * the focus border. */
static const char GLC_VS[] =
    "#version 300 es\n"
    "uniform vec4 u_rect;\n"
    "out vec2 v_uv;\n"
    "void main() {\n"
    "  vec2 t = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));\n"
    "  v_uv = t;\n"
    "  vec2 p = mix(u_rect.xy, u_rect.zw, t);\n"
    "  gl_Position = vec4(p, 0.0, 1.0);\n"
    "}\n";
static const char GLC_FS[] =
    "#version 300 es\n"
    "precision mediump float;\n"
    "uniform sampler2D u_tex;\n"
    "uniform vec4 u_color;\n"
    "uniform int u_use_tex;\n"
    "in vec2 v_uv;\n"
    "out vec4 o_color;\n"
    "void main() {\n"
    "  o_color = u_use_tex == 1 ? vec4(texture(u_tex, v_uv).bgr, 1.0)\n"
    "                           : u_color;\n"
    "}\n";

/* Compile one shader; returns 0 on failure. On a headless host the sync
 * GL queries fail (EIO) and COMPILE_STATUS reads back 0, so this doubles
 * as the GPU-availability probe. */
static GLuint glc_compile(GLenum type, const char *src) {
    GLuint sh = glCreateShader(type);
    glShaderSource(sh, 1, &src, NULL);
    glCompileShader(sh);
    GLint ok = 0;
    glGetShaderiv(sh, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        char log[256];
        glGetShaderInfoLog(sh, sizeof(log), NULL, log);
        fprintf(stderr, "wlcompositor: shader compile failed: %s\n", log);
        glDeleteShader(sh);
        return 0;
    }
    return sh;
}

/* Output-space pixels → NDC rect (y0 is the TOP edge; v_uv row 0 maps
 * to it, matching the texture's top scanline). */
static void glc_rect_ndc(int32_t x, int32_t y, int32_t w, int32_t h,
                         float out[4]) {
    out[0] = 2.0f * (float)x / (float)g.width - 1.0f;
    out[1] = 1.0f - 2.0f * (float)y / (float)g.height;
    out[2] = 2.0f * (float)(x + w) / (float)g.width - 1.0f;
    out[3] = 1.0f - 2.0f * (float)(y + h) / (float)g.height;
}

static void glc_draw_tex(unsigned tex, int32_t x, int32_t y,
                         int32_t w, int32_t h) {
    float r[4];
    glc_rect_ndc(x, y, w, h, r);
    glUniform4f(glc.loc_rect, r[0], r[1], r[2], r[3]);
    glUniform1i(glc.loc_use_tex, 1);
    glBindTexture(GL_TEXTURE_2D, tex);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
}

static void glc_draw_solid(uint32_t argb, int32_t x, int32_t y,
                           int32_t w, int32_t h) {
    float r[4];
    glc_rect_ndc(x, y, w, h, r);
    glUniform4f(glc.loc_rect, r[0], r[1], r[2], r[3]);
    glUniform1i(glc.loc_use_tex, 0);
    glUniform4f(glc.loc_color,
                (float)((argb >> 16) & 0xff) / 255.0f,
                (float)((argb >> 8) & 0xff) / 255.0f,
                (float)(argb & 0xff) / 255.0f, 1.0f);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
}

/* Import-once + rebind-on-commit texture for a client buffer. Returns 0
 * on failure (repaint degrades to the CPU path). NOTE: rebinding flushes
 * the cmdbuf, so this must run BEFORE the frame's draw sequence starts —
 * a flush mid-frame would present a half-composited desktop. */
static unsigned shm_buffer_gl_texture(struct shm_buffer *b) {
    if (!b->egl_bo_handle) {
        b->egl_bo_handle = wpkEglImportDmabufHandle(glc.dpy, b->pool->fd);
        if (!b->egl_bo_handle) return 0;
        b->gl_dirty = 1;
    }
    if (b->gl_dirty || !b->gl_tex) {
        unsigned tex = wpkEglBindBoTexture(glc.dpy, b->egl_bo_handle,
                                           GL_TEXTURE_2D);
        if (!tex) return 0;
        b->gl_tex = tex;
        b->gl_dirty = 0;
    }
    return b->gl_tex;
}

/* Stage the pre-rendered wallpaper through a dumb bo so the host uploads
 * it as a texture from shared storage — cmdbuf TLV records cap at 64 KB,
 * far below a framebuffer-sized glTexImage2D payload. */
static int setup_gl_wallpaper(void) {
    struct gbm_bo *bo = gbm_bo_create(g.gbm, g.width, g.height,
                                      GBM_FORMAT_XRGB8888, GBM_BO_USE_LINEAR);
    if (!bo) return -1;
    uint32_t stride = 0;
    void *map_data = NULL;
    uint32_t *px = gbm_bo_map(bo, 0, 0, g.width, g.height, 0, &stride,
                              &map_data);
    if (!px) { gbm_bo_destroy(bo); return -1; }
    for (uint32_t y = 0; y < g.height; y++)
        memcpy(px + (size_t)y * (stride / 4), g.wallpaper + (size_t)y * g.width,
               (size_t)g.width * 4);
    gbm_bo_unmap(bo, map_data);   /* flushes the bytes into host storage */

    int prime = gbm_bo_get_fd(bo);
    if (prime < 0) { gbm_bo_destroy(bo); return -1; }
    unsigned handle = wpkEglImportDmabufHandle(glc.dpy, prime);
    close(prime);
    if (!handle) { gbm_bo_destroy(bo); return -1; }
    glc.wallpaper_tex = wpkEglBindBoTexture(glc.dpy, handle, GL_TEXTURE_2D);
    if (!glc.wallpaper_tex) {
        wpkEglCloseBoHandle(glc.dpy, handle);
        gbm_bo_destroy(bo);
        return -1;
    }
    /* bo is intentionally never destroyed: it owns the texture's pixels. */
    return 0;
}

/* Probe + bring up the GPU compositing path. Any failure leaves
 * glc.active = 0 and the compositor on the CPU path — expected on Node
 * (no WebGL2) and forced by WLC_NO_GPU=1. */
static void setup_gl(void) {
    if (getenv("WLC_NO_GPU")) return;

    glc.dpy = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    EGLint maj = 0, min = 0;
    if (!eglInitialize(glc.dpy, &maj, &min)) return;

    static const EGLint ctx_attrs[] = { EGL_CONTEXT_CLIENT_VERSION, 3,
                                        EGL_NONE };
    glc.ctx = eglCreateContext(glc.dpy, NULL, EGL_NO_CONTEXT, ctx_attrs);
    if (glc.ctx == EGL_NO_CONTEXT) { eglTerminate(glc.dpy); return; }
    /* The drawing buffer must be mode-sized; we create the surface
     * before the first ADDFB, so the host cannot infer the size — pass
     * it explicitly (wpk libEGL honors EGL_WIDTH/EGL_HEIGHT). */
    const EGLint srf_attrs[] = { EGL_WIDTH, (EGLint)g.width,
                                 EGL_HEIGHT, (EGLint)g.height, EGL_NONE };
    glc.srf = eglCreateWindowSurface(glc.dpy, NULL, 0, srf_attrs);
    if (glc.srf == EGL_NO_SURFACE) { eglTerminate(glc.dpy); return; }
    if (!eglMakeCurrent(glc.dpy, glc.srf, glc.srf, glc.ctx)) {
        eglTerminate(glc.dpy);
        return;
    }

    GLuint vs = glc_compile(GL_VERTEX_SHADER, GLC_VS);
    if (!vs) { eglTerminate(glc.dpy); return; }   /* headless probe exit */
    GLuint fs = glc_compile(GL_FRAGMENT_SHADER, GLC_FS);
    if (!fs) { eglTerminate(glc.dpy); return; }
    glc.prog = glCreateProgram();
    glAttachShader(glc.prog, vs);
    glAttachShader(glc.prog, fs);
    glLinkProgram(glc.prog);
    GLint linked = 0;
    glGetProgramiv(glc.prog, GL_LINK_STATUS, &linked);
    if (!linked) {
        fprintf(stderr, "wlcompositor: GL program link failed\n");
        eglTerminate(glc.dpy);
        return;
    }
    glUseProgram(glc.prog);
    glc.loc_rect = glGetUniformLocation(glc.prog, "u_rect");
    glc.loc_use_tex = glGetUniformLocation(glc.prog, "u_use_tex");
    glc.loc_color = glGetUniformLocation(glc.prog, "u_color");
    glUniform1i(glGetUniformLocation(glc.prog, "u_tex"), 0);
    glViewport(0, 0, (GLsizei)g.width, (GLsizei)g.height);

    if (setup_gl_wallpaper() != 0) {
        fprintf(stderr, "wlcompositor: GL wallpaper staging failed\n");
        eglTerminate(glc.dpy);
        return;
    }
    glc.active = 1;
}

/* GPU frame: refresh dirty textures (host-side uploads, safe to flush),
 * then encode clear + wallpaper + z-ordered window quads and present
 * them in ONE cmdbuf flush via eglSwapBuffers. Returns 0 on failure so
 * repaint() can fall back to the CPU blit. */
static int repaint_gl(void) {
    unsigned texs[MAX_SURFACES] = {0};
    struct surface *top = NULL;
    for (int i = 0; i < g.n_surfaces; i++) {
        struct surface *s = g.zorder[i];
        if (!surface_visible(s) || !s->buffer) continue;
        struct shm_buffer *b = wl_resource_get_user_data(s->buffer);
        if (!b) continue;
        texs[i] = shm_buffer_gl_texture(b);
        if (!texs[i]) return 0;
    }

    glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    glc_draw_tex(glc.wallpaper_tex, 0, 0, (int32_t)g.width, (int32_t)g.height);
    for (int i = 0; i < g.n_surfaces; i++) {
        struct surface *s = g.zorder[i];
        if (!surface_visible(s) || !s->buffer || !texs[i]) continue;
        struct shm_buffer *b = wl_resource_get_user_data(s->buffer);
        if (!b) continue;
        if (g.kbd_focus == s)   /* 2px accent ring behind the window */
            glc_draw_solid(FOCUS_COLOR, s->x - 2, s->y - 2,
                           b->width + 4, b->height + 4);
        glc_draw_tex(texs[i], s->x, s->y, b->width, b->height);
        top = s;
    }
    /* A failed present (context loss) must degrade like a failed texture
     * bind — returning 1 here would keep glc.active set and freeze the
     * canvas on the last GL frame, the exact failure the CPU fallback
     * exists to prevent. */
    if (eglSwapBuffers(glc.dpy, glc.srf) != EGL_TRUE) return 0;

    /* One-shot proof that client pixels crossed the process boundary,
     * same contract as the CPU path's sample — but read back from the
     * composited GL framebuffer (glReadPixels via the sync query path). */
    if (top && !g.sampled) {
        int32_t sx = top->x + 10, sy = top->y + 10;
        if (sx >= 0 && sx < (int32_t)g.width && sy >= 0 &&
            sy < (int32_t)g.height) {
            uint8_t px[4] = {0};
            glReadPixels(sx, (int32_t)g.height - 1 - sy, 1, 1, GL_RGBA,
                         GL_UNSIGNED_BYTE, px);
            printf("COMPOSITE_SAMPLE x=%d y=%d px=0x%08x\n", sx, sy,
                   0xff000000u | ((uint32_t)px[0] << 16) |
                   ((uint32_t)px[1] << 8) | (uint32_t)px[2]);
            fflush(stdout);
            g.sampled = 1;
        }
    }
    return 1;
}

/* Render one frame: lock a free scanout bo, paint wallpaper + every mapped
 * surface bottom→top + focus border, then SetCrtc (first frame) or queue
 * a PAGE_FLIP. No software cursor: every real consumer (the browser
 * Modeset pane, a remote desktop) already shows the host pointer, and the
 * input bridge maps it absolutely so the two would sit on top of each
 * other. */
static void repaint(void) {
    if (!gbm_surface_has_free_buffers(g.gbm_surface)) return; /* retry on flip */

    struct gbm_bo *bo = gbm_surface_lock_front_buffer(g.gbm_surface);
    if (!bo) return;

    /* GPU path first. The scanout bo's CONTENT is stale under it (the
     * GL frame goes straight to the display canvas; the pump presenter
     * stood down when our context claimed it), but the bo still cycles
     * through ADDFB + PAGE_FLIP below — that is the frame clock for
     * wl_surface.frame callbacks and the kernel's flip counters. A
     * runtime GL failure degrades to the CPU path permanently. */
    if (glc.active && !repaint_gl()) {
        fprintf(stderr,
                "wlcompositor: GPU compositing failed; falling back to CPU\n");
        glc.active = 0;
        /* Tear the EGL session down so the host hands the display canvas
         * back to its vblank-pump presenter — otherwise the canvas would
         * freeze on the last GL frame while we CPU-composite into the
         * scanout bo. Also invalidates every egl_bo_handle; the CPU path
         * never touches them and wpkEglCloseBoHandle no-ops once the
         * session fd is gone. */
        eglTerminate(glc.dpy);
    }
    if (!glc.active) {
        uint32_t stride = 0;
        void *map_data = NULL;
        uint32_t *dst =
            gbm_bo_map(bo, 0, 0, g.width, g.height, 0, &stride, &map_data);
        if (!dst) {
            /* A persistent map failure would freeze the desktop with no
             * visible error — say so loudly. */
            fprintf(stderr, "wlcompositor: gbm_bo_map failed: %s\n",
                    strerror(errno));
            gbm_surface_release_buffer(g.gbm_surface, bo);
            return;
        }
        uint32_t stride_px = stride / 4;

        for (uint32_t y = 0; y < g.height; y++)
            memcpy(dst + (size_t)y * stride_px,
                   g.wallpaper + (size_t)y * g.width, (size_t)g.width * 4);

        struct surface *top = NULL;
        for (int i = 0; i < g.n_surfaces; i++) {
            struct surface *s = g.zorder[i];
            if (!surface_visible(s)) continue;
            if (g.kbd_focus == s) draw_focus_border(s, dst, stride_px);
            blit_surface(s, dst, stride_px);
            top = s;
        }
        /* One-shot proof that a client's pixels crossed the process
         * boundary: sample a pixel inside the topmost surface. If the
         * gbm_bo_import path (§8.1) worked, this is the client's color; if
         * the shared read silently failed we'd see the wallpaper instead.
         * The smoke gates assert on it. */
        if (top && !g.sampled) {
            int32_t sx = top->x + 10, sy = top->y + 10;
            if (sx >= 0 && sx < (int32_t)g.width && sy >= 0 &&
                sy < (int32_t)g.height) {
                printf("COMPOSITE_SAMPLE x=%d y=%d px=0x%08x\n", sx, sy,
                       dst[(size_t)sy * stride_px + sx]);
                fflush(stdout);
                g.sampled = 1;
            }
        }
        gbm_bo_unmap(bo, map_data);
    }

    uint32_t fb_id = bo_get_fb(bo);
    if (!fb_id) {
        fprintf(stderr, "wlcompositor: drmModeAddFB failed: %s\n",
                strerror(errno));
        gbm_surface_release_buffer(g.gbm_surface, bo);
        return;
    }

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
        send_all_frame_callbacks();
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
    /* If a flip is in flight, defer; the flip-complete handler repaints.
     * Also defer while draining a libinput event batch — repainting
     * between the bridge's peg and jump frames (see
     * handle_pointer_motion_rel) renders a move-grabbed window at the
     * pegged corner. One repaint per batch, after the drain loop. */
    if (g.pending_bo || g.in_input_batch) { g.repaint_needed = 1; return; }
    repaint();
}

/* card0 became readable → a page-flip completed. Release the previously
 * displayed bo, fire frame callbacks, and repaint if the desktop changed
 * while the flip was in flight. */
static void on_flip(int fd, unsigned int seq, unsigned int sec,
                    unsigned int usec, void *user_data) {
    if (g.pending_bo) {
        if (g.displayed_bo)
            gbm_surface_release_buffer(g.gbm_surface, g.displayed_bo);
        g.displayed_bo = g.pending_bo;
        g.pending_bo = NULL;
        send_all_frame_callbacks();
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

/* ---- keybind engine (config-driven) ------------------------------------ */

/* The base-level (shift-independent) keysym for an evdev keycode, so a bind
 * written as `1` matches whether or not Shift is held. */
static xkb_keysym_t base_keysym(uint32_t key) {
    struct xkb_keymap *km = xkb_state_get_keymap(g.xkb_state);
    xkb_layout_index_t layout = xkb_state_key_get_layout(g.xkb_state, key + 8);
    const xkb_keysym_t *syms;
    int n = xkb_keymap_key_get_syms_by_level(km, key + 8, layout, 0, &syms);
    return n > 0 ? syms[0] : XKB_KEY_NoSymbol;
}

/* The MOD_* bits currently active (only the mods our keymap defines). */
static uint32_t active_mod_mask(void) {
    uint32_t m = 0;
    if (xkb_state_mod_name_is_active(g.xkb_state, XKB_MOD_NAME_LOGO,
                                     XKB_STATE_MODS_EFFECTIVE) > 0) m |= MOD_SUPER;
    if (xkb_state_mod_name_is_active(g.xkb_state, XKB_MOD_NAME_SHIFT,
                                     XKB_STATE_MODS_EFFECTIVE) > 0) m |= MOD_SHIFT;
    if (xkb_state_mod_name_is_active(g.xkb_state, XKB_MOD_NAME_CTRL,
                                     XKB_STATE_MODS_EFFECTIVE) > 0) m |= MOD_CTRL;
    return m;
}

/* Move keyboard focus to the next/prev visible window in z-order WITHOUT
 * reordering (so a tiled layout keeps its geometry as focus cycles). */
static void focus_cycle(int dir) {
    struct surface *vis[MAX_SURFACES];
    int n = 0, cur = -1;
    for (int i = 0; i < g.n_surfaces; i++)
        if (surface_visible(g.zorder[i])) {
            if (g.zorder[i] == g.kbd_focus) cur = n;
            vis[n++] = g.zorder[i];
        }
    if (n == 0) return;
    int next = cur < 0 ? 0 : (cur + dir + n) % n;
    kbd_set_focus(vis[next]);
    ptr_refresh_focus();
}

static void run_dispatch(const struct keybind *b) {
    switch (b->action) {
    case ACT_EXEC: {
        char tmp[64];
        snprintf(tmp, sizeof(tmp), "%s", b->param);   /* kwlctl_exec strtoks */
        kwlctl_exec(tmp);
        break;
    }
    case ACT_WORKSPACE:    switch_workspace(b->arg); break;
    case ACT_MOVE_TO_WS:   move_focus_to_workspace(b->arg); break;
    case ACT_KILL:
        if (g.kbd_focus && g.kbd_focus->xdg_toplevel)
            xdg_toplevel_send_close(g.kbd_focus->xdg_toplevel);
        break;
    case ACT_CYCLE_NEXT:   focus_cycle(+1); break;
    case ACT_CYCLE_PREV:   focus_cycle(-1); break;
    }
}

/* Config-driven keybind interception. Returns 1 when the pressed combo matches
 * a bind and must NOT reach the focused client; the release of a matched combo
 * is swallowed too. xkb_state already reflects this key. */
static int try_keybind(uint32_t key, uint32_t state) {
    uint32_t mods = active_mod_mask();
    if (!mods) return 0;   /* fast path: unmodified keys go to the client */
    xkb_keysym_t sym = base_keysym(key);
    for (int i = 0; i < g.n_binds; i++) {
        if (g.binds[i].mods != mods || g.binds[i].sym != sym) continue;
        if (state == WL_KEYBOARD_KEY_STATE_PRESSED) run_dispatch(&g.binds[i]);
        return 1;
    }
    return 0;
}

/* ---- config parsing ----------------------------------------------------- */

static void add_bind(uint32_t mods, xkb_keysym_t sym, int action, int arg,
                     const char *param) {
    if (g.n_binds >= MAX_BINDS) return;
    struct keybind *b = &g.binds[g.n_binds++];
    b->mods = mods;
    b->sym = sym;
    b->action = action;
    b->arg = arg;
    snprintf(b->param, sizeof(b->param), "%s", param ? param : "");
}

/* Generic defaults when no config file is present (NOT demo-specific): the
 * standard SUPER-based tiling bindings. */
static void install_default_binds(void) {
    add_bind(MOD_SUPER, XKB_KEY_Return, ACT_EXEC, 0, "wlterm");
    add_bind(MOD_SUPER, XKB_KEY_w, ACT_KILL, 0, NULL);
    add_bind(MOD_SUPER, XKB_KEY_j, ACT_CYCLE_NEXT, 0, NULL);
    add_bind(MOD_SUPER, XKB_KEY_k, ACT_CYCLE_PREV, 0, NULL);
    for (int i = 1; i <= N_WORKSPACES; i++) {
        add_bind(MOD_SUPER, XKB_KEY_0 + i, ACT_WORKSPACE, i, NULL);
        add_bind(MOD_SUPER | MOD_SHIFT, XKB_KEY_0 + i, ACT_MOVE_TO_WS, i, NULL);
    }
}

/* Trim leading/trailing ASCII whitespace in place, returning the start. */
static char *trim(char *s) {
    while (*s == ' ' || *s == '\t') s++;
    char *end = s + strlen(s);
    while (end > s && (end[-1] == ' ' || end[-1] == '\t' || end[-1] == '\r' ||
                       end[-1] == '\n'))
        *--end = '\0';
    return s;
}

/* Parse a MODS token ("SUPER SHIFT" or "SUPER+SHIFT") into a MOD_* mask.
 * Returns -1 on an unknown modifier name. */
static int parse_mods(char *s, uint32_t *out) {
    uint32_t m = 0;
    for (char *tok = strtok(s, " +"); tok; tok = strtok(NULL, " +")) {
        if (!strcasecmp(tok, "SUPER") || !strcasecmp(tok, "MOD4")) m |= MOD_SUPER;
        else if (!strcasecmp(tok, "SHIFT")) m |= MOD_SHIFT;
        else if (!strcasecmp(tok, "CTRL") || !strcasecmp(tok, "CONTROL"))
            m |= MOD_CTRL;
        else return -1;
    }
    *out = m;
    return 0;
}

/* Parse one `bind = MODS, KEY, DISPATCHER[, ARGS]` line into the table. */
static void parse_bind_line(char *rhs) {
    char *fields[4] = {0};
    int nf = 0;
    for (char *tok = strtok(rhs, ","); tok && nf < 4; tok = strtok(NULL, ","))
        fields[nf++] = trim(tok);
    if (nf < 3) return;

    uint32_t mods;
    if (parse_mods(fields[0], &mods) < 0) return;
    xkb_keysym_t sym =
        xkb_keysym_from_name(fields[1], XKB_KEYSYM_CASE_INSENSITIVE);
    if (sym == XKB_KEY_NoSymbol) return;

    const char *disp = fields[2];
    const char *arg = nf > 3 ? fields[3] : "";
    if (!strcmp(disp, "exec"))            add_bind(mods, sym, ACT_EXEC, 0, arg);
    else if (!strcmp(disp, "workspace"))  add_bind(mods, sym, ACT_WORKSPACE, atoi(arg), NULL);
    else if (!strcmp(disp, "movetoworkspace")) add_bind(mods, sym, ACT_MOVE_TO_WS, atoi(arg), NULL);
    else if (!strcmp(disp, "killactive")) add_bind(mods, sym, ACT_KILL, 0, NULL);
    else if (!strcmp(disp, "cyclenext"))  add_bind(mods, sym, ACT_CYCLE_NEXT, 0, NULL);
    else if (!strcmp(disp, "cycleprev"))  add_bind(mods, sym, ACT_CYCLE_PREV, 0, NULL);
}

/* Load keybinds: parse WLC_CONFIG / WLC_CONFIG_PATH if present, else install
 * generic defaults. */
static void load_config(void) {
    const char *env = getenv("WLC_CONFIG");
    const char *path = env ? env : WLC_CONFIG_PATH;
    FILE *f = fopen(path, "r");
    const char *src;
    if (!f) {
        install_default_binds();
        src = "default";
    } else {
        char line[256];
        while (fgets(line, sizeof(line), f)) {
            char *s = trim(line);
            if (*s == '\0' || *s == '#') continue;
            if (strncmp(s, "bind", 4) == 0) {
                char *eq = strchr(s, '=');
                if (eq) parse_bind_line(trim(eq + 1));
            }
        }
        fclose(f);
        src = path;
    }
    printf("BINDS_LOADED n=%d source=%s\n", g.n_binds, src);
    fflush(stdout);
}

static void handle_keyboard(struct libinput_event_keyboard *k) {
    uint32_t key = libinput_event_keyboard_get_key(k);
    uint32_t state = libinput_event_keyboard_get_key_state(k) ==
                             LIBINPUT_KEY_STATE_PRESSED
                         ? WL_KEYBOARD_KEY_STATE_PRESSED
                         : WL_KEYBOARD_KEY_STATE_RELEASED;
    uint32_t serial = wl_display_next_serial(g.display);
    uint32_t t = now_ms();

    /* Track modifier state compositor-side; clients receive explicit
     * wl_keyboard.modifiers events (evdev keycode → xkb is a +8 offset). */
    xkb_state_update_key(g.xkb_state, key + 8,
                         state == WL_KEYBOARD_KEY_STATE_PRESSED ? XKB_KEY_DOWN
                                                                : XKB_KEY_UP);
    uint32_t dep, lat, lock, grp;
    current_mods(&dep, &lat, &lock, &grp);
    int mods_changed = dep != g.sent_mods_depressed ||
                       lat != g.sent_mods_latched ||
                       lock != g.sent_mods_locked || grp != g.sent_group;
    if (mods_changed) {
        g.sent_mods_depressed = dep;
        g.sent_mods_latched = lat;
        g.sent_mods_locked = lock;
        g.sent_group = grp;
    }

    /* Compositor keybinds intercept the key before the focused client. */
    if (try_keybind(key, state)) return;

    if (!g.kbd_focus) return;
    for (int i = 0; i < MAX_INPUT_RES; i++) {
        if (!g.keyboards[i] ||
            wl_resource_get_client(g.keyboards[i]) != g.kbd_focus->client)
            continue;
        wl_keyboard_send_key(g.keyboards[i], serial, t, key, state);
        if (mods_changed)
            wl_keyboard_send_modifiers(g.keyboards[i], serial, dep, lat, lock,
                                       grp);
    }
}

static void pointer_moved(void) {
    if (g.grab) {
        /* Interactive move: the window follows the cursor; clients see no
         * pointer events until the grab ends. */
        g.grab->x = (int32_t)(g.cursor_x - g.grab_dx);
        g.grab->y = (int32_t)(g.cursor_y - g.grab_dy);
        schedule_repaint();
        return;
    }
    /* Implicit grab: while a button is down, pointer focus stays pinned
     * to the surface that saw the press (Wayland semantics) — a drag
     * crossing the window edge keeps delivering motion (surface-local
     * coords may go out of bounds, which the protocol allows mid-grab),
     * and the eventual release reaches the pressed surface instead of
     * whatever the cursor is over. */
    if (g.buttons_down == 0)
        ptr_refresh_focus();
    if (g.ptr_focus) {
        uint32_t t = now_ms();
        wl_fixed_t lx = wl_fixed_from_double(g.cursor_x - g.ptr_focus->x);
        wl_fixed_t ly = wl_fixed_from_double(g.cursor_y - g.ptr_focus->y);
        for (int i = 0; i < MAX_INPUT_RES; i++)
            if (g.pointers[i] &&
                wl_resource_get_client(g.pointers[i]) == g.ptr_focus->client)
                wl_pointer_send_motion(g.pointers[i], t, lx, ly);
    }
    /* No repaint on bare motion: with no software cursor the desktop is
     * pixel-identical until a client commits in response. */
}

static void handle_pointer_motion_abs(struct libinput_event_pointer *p) {
    g.cursor_x = libinput_event_pointer_get_absolute_x_transformed(p, g.width);
    g.cursor_y = libinput_event_pointer_get_absolute_y_transformed(p, g.height);
    pointer_moved();
}

static void handle_pointer_motion_rel(struct libinput_event_pointer *p) {
    double dx = libinput_event_pointer_get_dx(p);
    double dy = libinput_event_pointer_get_dy(p);
    g.cursor_x += dx;
    g.cursor_y += dy;
    if (g.cursor_x < 0) g.cursor_x = 0;
    if (g.cursor_y < 0) g.cursor_y = 0;
    if (g.cursor_x > g.width) g.cursor_x = g.width;
    if (g.cursor_y > g.height) g.cursor_y = g.height;
    /* The browser/node absolute-pointer bridge (kandelo-session
     * sendPointerAbs) emulates each move as a peg frame (REL −4096 on
     * BOTH axes → cursor clamps to 0,0) followed by a jump frame to the
     * target. The peg is only a positioning artifact: acting on it moves
     * a grabbed window to the top-left corner for a frame and sends
     * clients a motion to (0,0). Real devices never emit −4096 on both
     * axes in one event, so treat it as position-only and let the jump
     * frame deliver the motion at the final coordinates. */
    if (dx <= -2048.0 && dy <= -2048.0) return;
    pointer_moved();
}

static void handle_pointer_button(struct libinput_event_pointer *p) {
    uint32_t button = libinput_event_pointer_get_button(p);
    int pressed = libinput_event_pointer_get_button_state(p) ==
                  LIBINPUT_BUTTON_STATE_PRESSED;
    uint32_t state = pressed ? WL_POINTER_BUTTON_STATE_PRESSED
                             : WL_POINTER_BUTTON_STATE_RELEASED;
    int was_down = g.buttons_down;
    g.buttons_down += pressed ? 1 : -1;
    if (g.buttons_down < 0) g.buttons_down = 0;

    if (!pressed && g.grab) {
        /* Drop the move grab; the cursor may now be over a different
         * surface (or a different part of the moved one). */
        printf("MOVE_END \"%s\" x=%d y=%d\n", g.grab->app_id, g.grab->x,
               g.grab->y);
        fflush(stdout);
        g.grab = NULL;
        ptr_refresh_focus();
        schedule_repaint();
        return;
    }

    if (pressed && was_down == 0) {
        /* Click-to-focus: raise the window under the cursor and give it
         * keyboard focus before delivering the press. Further presses
         * while a button is already down join the implicit grab — focus
         * stays pinned to the pressed surface. */
        struct surface *s = surface_at(g.cursor_x, g.cursor_y);
        if (s) {
            zorder_raise(s);
            kbd_set_focus(s);
        }
        ptr_refresh_focus();
    }

    if (g.ptr_focus) {
        uint32_t serial = wl_display_next_serial(g.display);
        uint32_t t = now_ms();
        for (int i = 0; i < MAX_INPUT_RES; i++)
            if (g.pointers[i] &&
                wl_resource_get_client(g.pointers[i]) == g.ptr_focus->client)
                wl_pointer_send_button(g.pointers[i], serial, t, button, state);
    }

    /* The implicit grab ends with the last release: only now may focus
     * follow the cursor again. */
    if (!pressed && g.buttons_down == 0)
        ptr_refresh_focus();
}

static int libinput_readable(int fd, uint32_t mask, void *data) {
    libinput_dispatch(g.li);
    struct libinput_event *ev;
    g.in_input_batch = 1;
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
    g.in_input_batch = 0;
    if (g.repaint_needed && !g.pending_bo) {
        g.repaint_needed = 0;
        repaint();
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
 * write the canonical string to a file each keyboard bind re-opens for a
 * mappable fd (see send_keymap). The compositor keeps its own xkb_state on
 * the same keymap to drive wl_keyboard.modifiers. */
static int setup_keymap(void) {
    /* A self-contained US-QWERTY map. Keycodes are evdev codes + 8 (the fixed
     * xkb offset), so an evdev KEY_* the compositor receives from libinput
     * lands on the matching xkb key here. Enough of a real keyboard for a
     * terminal: letters, digits, common punctuation, space, Return, Tab,
     * Backspace, Escape, both Shifts and left Control. Two levels (base /
     * Shift) via TWO_LEVEL; the bare action keys are ONE_LEVEL. */
    static const char KEYMAP[] =
        "xkb_keymap {\n"
        "  xkb_keycodes \"kandelo\" {\n"
        "    minimum = 8;\n"
        "    maximum = 255;\n"
        "    <ESC>  = 9;\n"
        "    <AE01> = 10;  <AE02> = 11;  <AE03> = 12;  <AE04> = 13;\n"
        "    <AE05> = 14;  <AE06> = 15;  <AE07> = 16;  <AE08> = 17;\n"
        "    <AE09> = 18;  <AE10> = 19;  <AE11> = 20;  <AE12> = 21;\n"
        "    <BKSP> = 22;  <TAB>  = 23;\n"
        "    <AD01> = 24;  <AD02> = 25;  <AD03> = 26;  <AD04> = 27;\n"
        "    <AD05> = 28;  <AD06> = 29;  <AD07> = 30;  <AD08> = 31;\n"
        "    <AD09> = 32;  <AD10> = 33;  <AD11> = 34;  <AD12> = 35;\n"
        "    <RTRN> = 36;  <LCTL> = 37;\n"
        "    <AC01> = 38;  <AC02> = 39;  <AC03> = 40;  <AC04> = 41;\n"
        "    <AC05> = 42;  <AC06> = 43;  <AC07> = 44;  <AC08> = 45;\n"
        "    <AC09> = 46;  <AC10> = 47;  <AC11> = 48;  <TLDE> = 49;\n"
        "    <LFSH> = 50;  <BKSL> = 51;\n"
        "    <AB01> = 52;  <AB02> = 53;  <AB03> = 54;  <AB04> = 55;\n"
        "    <AB05> = 56;  <AB06> = 57;  <AB07> = 58;  <AB08> = 59;\n"
        "    <AB09> = 60;  <AB10> = 61;  <RTSH> = 62;  <SPCE> = 65;\n"
        "    <LWIN> = 133;\n"   /* evdev KEY_LEFTMETA (125) + 8: the SUPER key */
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
        "    interpret Shift_R+AnyOfOrNone(all) {\n"
        "      action = SetMods(modifiers=Shift);\n"
        "    };\n"
        "    interpret Control_L+AnyOfOrNone(all) {\n"
        "      action = SetMods(modifiers=Control);\n"
        "    };\n"
        "    interpret Super_L+AnyOfOrNone(all) {\n"
        "      action = SetMods(modifiers=Mod4);\n"
        "    };\n"
        "  };\n"
        "  xkb_symbols \"kandelo\" {\n"
        "    key <ESC>  { [ Escape ] };\n"
        "    key <BKSP> { [ BackSpace ] };\n"
        "    key <TAB>  { [ Tab ] };\n"
        "    key <RTRN> { [ Return ] };\n"
        "    key <SPCE> { [ space ] };\n"
        "    key <LCTL> { [ Control_L ] };\n"
        "    key <LFSH> { [ Shift_L ] };\n"
        "    key <RTSH> { [ Shift_R ] };\n"
        "    key <LWIN> { [ Super_L ] };\n"
        "    key <AE01> { type=\"TWO_LEVEL\", [ 1, exclam ] };\n"
        "    key <AE02> { type=\"TWO_LEVEL\", [ 2, at ] };\n"
        "    key <AE03> { type=\"TWO_LEVEL\", [ 3, numbersign ] };\n"
        "    key <AE04> { type=\"TWO_LEVEL\", [ 4, dollar ] };\n"
        "    key <AE05> { type=\"TWO_LEVEL\", [ 5, percent ] };\n"
        "    key <AE06> { type=\"TWO_LEVEL\", [ 6, asciicircum ] };\n"
        "    key <AE07> { type=\"TWO_LEVEL\", [ 7, ampersand ] };\n"
        "    key <AE08> { type=\"TWO_LEVEL\", [ 8, asterisk ] };\n"
        "    key <AE09> { type=\"TWO_LEVEL\", [ 9, parenleft ] };\n"
        "    key <AE10> { type=\"TWO_LEVEL\", [ 0, parenright ] };\n"
        "    key <AE11> { type=\"TWO_LEVEL\", [ minus, underscore ] };\n"
        "    key <AE12> { type=\"TWO_LEVEL\", [ equal, plus ] };\n"
        "    key <AD01> { type=\"TWO_LEVEL\", [ q, Q ] };\n"
        "    key <AD02> { type=\"TWO_LEVEL\", [ w, W ] };\n"
        "    key <AD03> { type=\"TWO_LEVEL\", [ e, E ] };\n"
        "    key <AD04> { type=\"TWO_LEVEL\", [ r, R ] };\n"
        "    key <AD05> { type=\"TWO_LEVEL\", [ t, T ] };\n"
        "    key <AD06> { type=\"TWO_LEVEL\", [ y, Y ] };\n"
        "    key <AD07> { type=\"TWO_LEVEL\", [ u, U ] };\n"
        "    key <AD08> { type=\"TWO_LEVEL\", [ i, I ] };\n"
        "    key <AD09> { type=\"TWO_LEVEL\", [ o, O ] };\n"
        "    key <AD10> { type=\"TWO_LEVEL\", [ p, P ] };\n"
        "    key <AD11> { type=\"TWO_LEVEL\", [ bracketleft, braceleft ] };\n"
        "    key <AD12> { type=\"TWO_LEVEL\", [ bracketright, braceright ] };\n"
        "    key <AC01> { type=\"TWO_LEVEL\", [ a, A ] };\n"
        "    key <AC02> { type=\"TWO_LEVEL\", [ s, S ] };\n"
        "    key <AC03> { type=\"TWO_LEVEL\", [ d, D ] };\n"
        "    key <AC04> { type=\"TWO_LEVEL\", [ f, F ] };\n"
        "    key <AC05> { type=\"TWO_LEVEL\", [ g, G ] };\n"
        "    key <AC06> { type=\"TWO_LEVEL\", [ h, H ] };\n"
        "    key <AC07> { type=\"TWO_LEVEL\", [ j, J ] };\n"
        "    key <AC08> { type=\"TWO_LEVEL\", [ k, K ] };\n"
        "    key <AC09> { type=\"TWO_LEVEL\", [ l, L ] };\n"
        "    key <AC10> { type=\"TWO_LEVEL\", [ semicolon, colon ] };\n"
        "    key <AC11> { type=\"TWO_LEVEL\", [ apostrophe, quotedbl ] };\n"
        "    key <TLDE> { type=\"TWO_LEVEL\", [ grave, asciitilde ] };\n"
        "    key <BKSL> { type=\"TWO_LEVEL\", [ backslash, bar ] };\n"
        "    key <AB01> { type=\"TWO_LEVEL\", [ z, Z ] };\n"
        "    key <AB02> { type=\"TWO_LEVEL\", [ x, X ] };\n"
        "    key <AB03> { type=\"TWO_LEVEL\", [ c, C ] };\n"
        "    key <AB04> { type=\"TWO_LEVEL\", [ v, V ] };\n"
        "    key <AB05> { type=\"TWO_LEVEL\", [ b, B ] };\n"
        "    key <AB06> { type=\"TWO_LEVEL\", [ n, N ] };\n"
        "    key <AB07> { type=\"TWO_LEVEL\", [ m, M ] };\n"
        "    key <AB08> { type=\"TWO_LEVEL\", [ comma, less ] };\n"
        "    key <AB09> { type=\"TWO_LEVEL\", [ period, greater ] };\n"
        "    key <AB10> { type=\"TWO_LEVEL\", [ slash, question ] };\n"
        "    modifier_map Shift { <LFSH>, <RTSH> };\n"
        "    modifier_map Control { <LCTL> };\n"
        "    modifier_map Mod4 { <LWIN> };\n"
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
    close(fd);
    g.xkb_keymap_size = (uint32_t)len;
    free(str);

    g.xkb_state = xkb_state_new(keymap);
    xkb_keymap_unref(keymap);   /* the state holds its own reference */
    xkb_context_unref(ctx);
    return g.xkb_state ? 0 : -1;
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

/* Pre-render the desktop background once: a vertical gradient with a faint
 * grid and a wordmark. Painted per-frame with row memcpys. */
static int setup_wallpaper(void) {
    g.wallpaper = malloc((size_t)g.width * g.height * 4);
    if (!g.wallpaper) return -1;

    for (uint32_t y = 0; y < g.height; y++) {
        /* #10121a (top) → #1b2233 (bottom). */
        uint32_t t = g.height > 1 ? (y * 256u) / (g.height - 1) : 0;
        uint32_t rr = 0x10 + ((0x1b - 0x10) * t) / 256;
        uint32_t gg = 0x12 + ((0x22 - 0x12) * t) / 256;
        uint32_t bb = 0x1a + ((0x33 - 0x1a) * t) / 256;
        uint32_t px = 0xff000000u | (rr << 16) | (gg << 8) | bb;
        uint32_t *row = g.wallpaper + (size_t)y * g.width;
        for (uint32_t x = 0; x < g.width; x++) row[x] = px;
    }

    struct wpk_surface wp =
        wpk_surface_wrap(g.wallpaper, (int)g.width, (int)g.height, 0);

    /* Faint 120px grid. */
    const wpk_color grid = 0x0affffffu;   /* ~4% white */
    for (uint32_t x = 0; x < g.width; x += 120)
        wpk_rect(&wp, (int)x, 0, 1, (int)g.height, grid);
    for (uint32_t y = 0; y < g.height; y += 120)
        wpk_rect(&wp, 0, (int)y, (int)g.width, 1, grid);

    struct wpk_font *big = wpk_font_load_default(56);
    struct wpk_font *small = wpk_font_load_default(20);
    if (big) {
        wpk_text(&wp, big, 96, (int)g.height - 150, "Kandelo",
                 WPK_RGB(0x3e, 0x4a, 0x66));
        wpk_font_destroy(big);
    }
    if (small) {
        wpk_text(&wp, small, 98, (int)g.height - 112,
                 "Wayland on a wasm32 POSIX kernel", WPK_RGB(0x36, 0x40, 0x58));
        wpk_text(&wp, small, 98, (int)g.height - 84,
                 "click to focus - drag title bars to move windows",
                 WPK_RGB(0x2e, 0x37, 0x4c));
        wpk_font_destroy(small);
    }
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
    /* Drain the initial DEVICE_ADDED events. While at it, force the flat
     * acceleration profile at speed 0 (gain 1.0) on every pointer: the
     * browser host feeds absolute positions EMULATED as relative deltas
     * (a huge negative peg to (0,0) followed by one +x/+y jump, see
     * kandelo-session sendPointerAbs), and the default adaptive accel
     * curve multiplies those jumps so the cursor lands nowhere near the
     * target. Flat/0 makes REL deltas pixel-exact. */
    struct libinput_event *ev;
    while ((ev = libinput_get_event(g.li)) != NULL) {
        if (libinput_event_get_type(ev) == LIBINPUT_EVENT_DEVICE_ADDED) {
            struct libinput_device *dev = libinput_event_get_device(ev);
            if (libinput_device_config_accel_is_available(dev)) {
                libinput_device_config_accel_set_profile(
                    dev, LIBINPUT_CONFIG_ACCEL_PROFILE_FLAT);
                libinput_device_config_accel_set_speed(dev, 0.0);
            }
        }
        libinput_event_destroy(ev);
    }
    g.cursor_x = g.width / 2.0;
    g.cursor_y = g.height / 2.0;
    return 0;
}

/* Bind + listen an AF_UNIX socket at the fixed Wayland path and hand it to
 * libwayland. We manage the socket ourselves (rather than
 * wl_display_add_socket, which derives the path from XDG_RUNTIME_DIR) so
 * the path is deterministic for the client. */
/* ====================================================================== */
/* kwlctl control + event IPC (the hyprctl analog)                        */
/* ====================================================================== */

/* One control-socket connection. A plain request/reply connection is closed
 * after its reply; a --listen connection stays open and joins g.listeners to
 * receive the event stream. */
struct kwlctl_conn {
    int fd;
    struct wl_event_source *src;
    int listening;
};

static void kwlctl_send(int fd, const char *buf, int len) {
    for (int off = 0; off < len; ) {
        ssize_t w = write(fd, buf + off, (size_t)(len - off));
        if (w <= 0) break;   /* dead peer: reaped on its next readable/EOF */
        off += (int)w;
    }
}

/* Push one `event>>data` line (Hyprland socket2 format) to every listener. */
static void kwlctl_emit(const char *fmt, ...) {
    char buf[256];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf, sizeof(buf) - 1, fmt, ap);
    va_end(ap);
    if (n < 0) return;
    if (n > (int)sizeof(buf) - 1) n = (int)sizeof(buf) - 1;
    buf[n++] = '\n';
    for (int i = 0; i < MAX_KWLCTL_CONNS; i++)
        if (g.listeners[i]) kwlctl_send(g.listeners[i]->fd, buf, n);
}

/* JSON describing one surface, Hyprland `clients -j`-shaped subset. */
static int kwlctl_window_json(char *buf, size_t cap, struct surface *s) {
    return snprintf(buf, cap,
        "{\"address\":\"%p\",\"class\":\"%s\",\"workspace\":{\"id\":%d},"
        "\"at\":[%d,%d],\"size\":[%d,%d],\"focused\":%s}",
        (void *)s, s->app_id, s->workspace, s->x, s->y, s->w, s->h,
        g.kbd_focus == s ? "true" : "false");
}

static int kwlctl_clients_json(char *buf, size_t cap) {
    int n = snprintf(buf, cap, "[");
    int first = 1;
    for (int i = 0; i < g.n_surfaces && n < (int)cap; i++) {
        struct surface *s = g.zorder[i];
        if (!s->mapped) continue;
        if (!first) n += snprintf(buf + n, cap - n, ",");
        n += kwlctl_window_json(buf + n, cap - n, s);
        first = 0;
    }
    n += snprintf(buf + n, cap - n, "]\n");
    return n;
}

static int kwlctl_workspaces_json(char *buf, size_t cap) {
    int counts[N_WORKSPACES + 1] = {0};
    for (int i = 0; i < g.n_surfaces; i++)
        if (g.zorder[i]->mapped) counts[g.zorder[i]->workspace]++;
    int n = snprintf(buf, cap, "[");
    int first = 1;
    for (int ws = 1; ws <= N_WORKSPACES && n < (int)cap; ws++) {
        if (!counts[ws] && ws != g.active_ws) continue;
        n += snprintf(buf + n, cap - n,
                      "%s{\"id\":%d,\"windows\":%d,\"active\":%s}",
                      first ? "" : ",", ws, counts[ws],
                      ws == g.active_ws ? "true" : "false");
        first = 0;
    }
    n += snprintf(buf + n, cap - n, "]\n");
    return n;
}

static int kwlctl_activewindow_json(char *buf, size_t cap) {
    if (!g.kbd_focus) return snprintf(buf, cap, "{}\n");
    int n = kwlctl_window_json(buf, cap, g.kbd_focus);
    n += snprintf(buf + n, cap - n, "\n");
    return n;
}

/* dispatch exec: launch a client with the NON-forking posix_spawnp
 * (SYS_SPAWN, see docs/plans/2026-05-04-non-forking-posix-spawn-design.md).
 * fork() from inside a wl_event_loop callback would wedge the server; the
 * direct spawn syscall sidesteps it entirely and needs no fork instrumentation.
 * posix_spawnp walks PATH in libc and passes the kernel one resolved path. */
static void kwlctl_exec(char *args) {
    char *argv[16];
    int argc = 0;
    for (char *tok = strtok(args, " "); tok && argc < 15;
         tok = strtok(NULL, " "))
        argv[argc++] = tok;
    argv[argc] = NULL;
    if (argc == 0) return;
    extern char **environ;
    pid_t pid = 0;
    int rc = posix_spawnp(&pid, argv[0], NULL, NULL, argv, environ);
    if (rc != 0) {
        fprintf(stderr, "posix_spawnp %s: %s\n", argv[0], strerror(rc));
        return;
    }
    printf("KWLCTL_EXEC \"%s\" pid=%d\n", argv[0], (int)pid);
    fflush(stdout);
}

static void kwlctl_conn_close(struct kwlctl_conn *c) {
    if (c->listening)
        for (int i = 0; i < MAX_KWLCTL_CONNS; i++)
            if (g.listeners[i] == c) { g.listeners[i] = NULL; break; }
    if (c->src) wl_event_source_remove(c->src);
    close(c->fd);
    free(c);
}

/* Execute one command line. Returns 1 to keep the connection open (--listen),
 * 0 to close after the reply. */
static int kwlctl_handle(struct kwlctl_conn *c, char *line) {
    char buf[4096];
    if (strcmp(line, "clients") == 0) {
        kwlctl_send(c->fd, buf, kwlctl_clients_json(buf, sizeof(buf)));
        return 0;
    }
    if (strcmp(line, "workspaces") == 0) {
        kwlctl_send(c->fd, buf, kwlctl_workspaces_json(buf, sizeof(buf)));
        return 0;
    }
    if (strcmp(line, "activewindow") == 0) {
        kwlctl_send(c->fd, buf, kwlctl_activewindow_json(buf, sizeof(buf)));
        return 0;
    }
    if (strncmp(line, "dispatch ", 9) == 0) {
        char *op = line + 9;
        if (strncmp(op, "workspace ", 10) == 0)
            switch_workspace(atoi(op + 10));
        else if (strncmp(op, "movetoworkspace ", 16) == 0)
            move_focus_to_workspace(atoi(op + 16));
        else if (strcmp(op, "close") == 0) {
            if (g.kbd_focus && g.kbd_focus->xdg_toplevel)
                xdg_toplevel_send_close(g.kbd_focus->xdg_toplevel);
        } else if (strncmp(op, "exec ", 5) == 0)
            kwlctl_exec(op + 5);
        else {
            kwlctl_send(c->fd, "err unknown dispatch\n", 21);
            return 0;
        }
        kwlctl_send(c->fd, "ok\n", 3);
        return 0;
    }
    if (strncmp(line, "keyword layout ", 15) == 0) {
        g.layout = strcmp(line + 15, "dwindle") == 0 ? LAYOUT_DWINDLE
                                                     : LAYOUT_FLOATING;
        retile();
        kwlctl_send(c->fd, "ok\n", 3);
        return 0;
    }
    if (strcmp(line, "--listen") == 0) {
        for (int i = 0; i < MAX_KWLCTL_CONNS; i++)
            if (!g.listeners[i]) {
                g.listeners[i] = c;
                c->listening = 1;
                kwlctl_send(c->fd, "listening\n", 10);
                return 1;
            }
        kwlctl_send(c->fd, "err too many listeners\n", 23);
        return 0;
    }
    kwlctl_send(c->fd, "err unknown command\n", 20);
    return 0;
}

static int kwlctl_conn_readable(int fd, uint32_t mask, void *data) {
    (void)mask;
    struct kwlctl_conn *c = data;
    char line[1024];
    ssize_t r = read(fd, line, sizeof(line) - 1);
    if (r <= 0) { kwlctl_conn_close(c); return 0; }
    while (r > 0 && (line[r - 1] == '\n' || line[r - 1] == '\r')) r--;
    line[r] = '\0';
    if (!kwlctl_handle(c, line)) kwlctl_conn_close(c);
    return 0;
}

static int kwlctl_listen_readable(int fd, uint32_t mask, void *data) {
    (void)mask; (void)data;
    int cfd = accept(fd, NULL, NULL);
    if (cfd < 0) return 0;
    /* Don't leak this control fd into `dispatch exec` children: an inherited
     * copy keeps the socket half-open so the kwlctl client never sees EOF. */
    fcntl(cfd, F_SETFD, FD_CLOEXEC);
    struct kwlctl_conn *c = calloc(1, sizeof(*c));
    if (!c) { close(cfd); return 0; }
    c->fd = cfd;
    c->src = wl_event_loop_add_fd(g.loop, cfd, WL_EVENT_READABLE,
                                  kwlctl_conn_readable, c);
    return 0;
}

static int setup_kwlctl(void) {
    unlink(KWLCTL_SOCKET_PATH);
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) { perror("socket kwlctl"); return -1; }
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, KWLCTL_SOCKET_PATH, sizeof(addr.sun_path) - 1);
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("bind kwlctl"); close(fd); return -1;
    }
    if (listen(fd, 8) < 0) { perror("listen kwlctl"); close(fd); return -1; }
    wl_event_loop_add_fd(g.loop, fd, WL_EVENT_READABLE, kwlctl_listen_readable,
                         NULL);
    return 0;
}

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

    /* Layout policy. Absent/unknown WLC_LAYOUT keeps the floating desktop so
     * /?demo=wayland is unchanged; WLC_LAYOUT=dwindle selects the tiler. */
    g.active_ws = 1;
    const char *want_layout = getenv("WLC_LAYOUT");
    if (want_layout && strcmp(want_layout, "dwindle") == 0)
        g.layout = LAYOUT_DWINDLE;
    printf("WLC_LAYOUT %s\n",
           g.layout == LAYOUT_DWINDLE ? "dwindle" : "floating");
    fflush(stdout);
    load_config();

    if (setup_drm() != 0) return 1;
    if (setup_wallpaper() != 0) return 1;
    /* GPU compositing is best-effort: on hosts without WebGL2 (Node
     * smokes, degraded headless) the probe fails and we CPU-composite. */
    setup_gl();
    printf("WLC_RENDERER %s\n", glc.active ? "gpu" : "cpu");
    fflush(stdout);
    if (setup_keymap() != 0) return 1;
    if (setup_input() != 0) return 1;

    /* Globals. Versions are the minimum that carry the events we send. */
    if (!wl_global_create(g.display, &wl_compositor_interface, 4, NULL,
                          compositor_bind) ||
        !wl_global_create(g.display, &wl_shm_interface, 1, NULL, shm_bind) ||
        !wl_global_create(g.display, &zwp_linux_dmabuf_v1_interface, 3, NULL,
                          dmabuf_bind) ||
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

    /* Auto-reap `dispatch exec` children so they don't linger as zombies. */
    signal(SIGCHLD, SIG_IGN);
    if (setup_kwlctl() != 0) return 1;

    printf("COMPOSITOR_UP w=%u h=%u\n", g.width, g.height);
    fflush(stdout);

    /* Show the desktop wallpaper before any client maps. */
    schedule_repaint();

    wl_display_run(g.display);

    printf("COMPOSITOR_DONE\n");
    fflush(stdout);
    wl_display_destroy(g.display);
    return 0;
}
