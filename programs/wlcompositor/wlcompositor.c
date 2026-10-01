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
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <math.h>
#include <regex.h>
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
#include "xdg-decoration-v1-server-protocol.h"
#include "wlr-layer-shell-v1-server-protocol.h"
#include "presentation-time-server-protocol.h"
#include "xdg-output-v1-server-protocol.h"
#include "viewporter-server-protocol.h"
#include "fractional-scale-v1-server-protocol.h"
#include "wlr-data-control-v1-server-protocol.h"
#include "ext-data-control-v1-server-protocol.h"
#include "ext-session-lock-v1-server-protocol.h"
#include "ext-idle-notify-v1-server-protocol.h"
#include "hyprland-global-shortcuts-v1-server-protocol.h"

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
/* The Hyprland IPC socket pair, where Waybar's hyprland modules expect it:
 * $XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/.socket.sock (request/
 * reply) + .socket2.sock (event stream). XDG_RUNTIME_DIR is /tmp here (see
 * WL_SOCKET_PATH above); main() exports the signature so spawned clients
 * find the dir. Requests answer in hyprctl -j shapes; both sockets share
 * kwlctl's command table and event broadcast. */
#define HYPR_INSTANCE_SIG  "wlcompositor"
#define HYPR_DIR           "/tmp/hypr/" HYPR_INSTANCE_SIG
#define HYPR_SOCKET1_PATH  HYPR_DIR "/.socket.sock"
#define HYPR_SOCKET2_PATH  HYPR_DIR "/.socket2.sock"
#define WL_KEYMAP_PATH "/tmp/wlcompositor-keymap.xkb"
#define MAX_FRAME_CB   32     /* pending frame callbacks per surface */
#define FOCUS_COLOR    0xff4f8fdfu  /* default accent ring; themes override */
#define N_WORKSPACES   9      /* SUPER+1..9, Hyprland's 1-based workspaces */
/* wl_output.scale is integer-only; 3 covers every devicePixelRatio a
 * browser reports without letting a bad WLC_SCALE shrink the logical grid
 * to nothing. */
#define MAX_OUTPUT_SCALE 3

/* The config path, hyprland.conf-shaped subset. Absent = generic defaults
 * (install_default_binds); WLC_CONFIG overrides for tests. */
#define WLC_CONFIG_PATH "/etc/kandelo/wlcompositor.conf"
#define MAX_BINDS 128
/* `windowrule = tag +NAME, class:REGEX` rules, and the tag names they use.
 * Tags are a bitmask on each surface, so MAX_TAGS fits in a uint32_t. */
#define MAX_WINDOW_RULES 32
#define MAX_TAGS 32
/* Kandelo-only dispatchers carry Hyprland's plugin-dispatcher namespace, so a
 * reader of the config sees at once that stock Hyprland lacks them. */
#define DISP_SENDSHORTCUT_IF_TAG "kandelo:sendshortcutiftag"

/* Themes are just files, the way Omarchy does it: one directory per theme
 * holding a palette the compositor and every shell client read. WLC_THEME_DIR
 * overrides the root for tests. */
#define THEME_DIR "/usr/share/kandelo/themes"
#define MAX_THEMES 16

/* Modifier bits used by the keybind engine (mapped from xkb mod state). */
#define MOD_SUPER 1
#define MOD_SHIFT 2
#define MOD_CTRL  4   /* the browser reserves SUPER (Cmd/Win), so CTRL is the
                         usable modifier for the in-browser demo */
#define MOD_ALT   8

enum bind_action {
    ACT_EXEC, ACT_WORKSPACE, ACT_MOVE_TO_WS, ACT_KILL,
    ACT_CYCLE_NEXT, ACT_CYCLE_PREV, ACT_THEME, ACT_SWAP,
    ACT_SEND_SHORTCUT, ACT_SEND_SHORTCUT_IF_TAG, ACT_GLOBAL,
};

/* A chord a `sendshortcut` dispatcher delivers: MOD_* bits and the
 * base-level keysym of the key. */
struct shortcut {
    uint32_t mods;
    xkb_keysym_t sym;
};

/* One `bind = MODS, KEY, DISPATCHER, ARGS` rule. sym is the BASE-level keysym
 * (shift-independent) so `SUPER SHIFT, 1` matches the same key as `SUPER, 1`. */
struct keybind {
    uint32_t mods;         /* MOD_* bitmask; matched exactly */
    xkb_keysym_t sym;
    int action;
    int arg;               /* workspace number for workspace/movetoworkspace;
                            * tag index for kandelo:sendshortcutiftag */
    char param[256];       /* command line for exec */
    /* sendshortcut: shortcut[0]. kandelo:sendshortcutiftag: shortcut[0] when the
     * focused window carries tag `arg`, else shortcut[1]. */
    struct shortcut shortcut[2];
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
    /* attach was called since the last commit. Distinguishes attach(NULL)
     * -- the client unmapping the surface -- from no attach at all, which
     * pending_buffer == NULL alone cannot. */
    int pending_attached;
    struct wl_resource *buffer;         /* committed, retained for repaints */
    struct wl_resource *xdg_surface;    /* xdg_surface wrapping this surface */
    struct wl_resource *xdg_toplevel;
    unsigned frame_tex;                 /* repaint_gl: this frame's texture */
    /* xdg-shell configure handshake: the serial of the configure sent for
     * the current role, and whether the client has acked it. A toplevel
     * maps only once configured; a buffer committed earlier is a client
     * error (unconfigured_buffer). */
    uint32_t configure_serial;
    int configured;
    /* Every configure serial sent and not yet acked, oldest first. A client
     * may ack any configure it received, including one a later configure
     * superseded (tiling reconfigures windows freely), so an ack is valid
     * if it names any of these. */
    struct wl_array pending_serials;
    /* wlr-layer-shell role: set instead of the xdg pair for a shell
     * component (the bar, the launcher). A layer surface is anchored by the
     * compositor, never tiled, and lives above or below every toplevel. */
    struct wl_resource *layer_surface;
    uint32_t layer;                     /* ZWLR_LAYER_SHELL_V1_LAYER_* */
    uint32_t anchor;                    /* ZWLR_LAYER_SURFACE_V1_ANCHOR_* mask */
    int32_t exclusive_zone;             /* px reserved from the anchored edge */
    int32_t margin_top, margin_right, margin_bottom, margin_left;
    uint32_t kb_interactive;            /* ZWLR_LAYER_SURFACE_V1_KEYBOARD_* */
    int32_t req_w, req_h;               /* set_size; 0 = compositor decides */
    int layer_configured;               /* first configure sent */
    int layer_dirty;                    /* a layer-shell request is waiting for
                                         * the commit that applies it */
    int layer_announced;                /* LAYER marker printed while mapped */
    /* ext-session-lock role: the surface shown while the session is locked.
     * Full-output, above everything, and the only thing input reaches. */
    struct wl_resource *lock_surface;
    int lock_acked;
    char app_id[32];
    uint32_t tags;                      /* bit i = tag_names[i], from windowrules */
    char title[96];                     /* xdg_toplevel.set_title, for the bar */
    int32_t x, y;                       /* top-left on the output */
    int32_t w, h;                       /* committed buffer dims */
    int workspace;                      /* 1..N_WORKSPACES; 0 until first map */
    int mapped;                         /* has a committed buffer been shown */
    int placed;                         /* position assigned at first map */
    struct wl_resource *frame_cbs[MAX_FRAME_CB];
    int n_frame_cbs;
    /* wp_presentation_feedback resources awaiting the next flip. */
    struct wl_resource *feedbacks[MAX_FRAME_CB];
    int n_feedbacks;
    /* wl_subsurface role: glued to `parent` at (sub_x, sub_y), composited
     * right above it, never tiled, never focused, never hit-tested. */
    struct wl_resource *subsurface;
    struct surface *parent;
    int32_t sub_x, sub_y;
    /* wp_viewport crop + scale. vp_src_w <= 0 = no source rect (w must be
     * positive when set, so the calloc zero means unset); vp_dst_w <= 0 =
     * no destination size. */
    struct wl_resource *viewport;
    wl_fixed_t vp_src_x, vp_src_y, vp_src_w, vp_src_h;
    int32_t vp_dst_w, vp_dst_h;
    struct wl_resource *fractional_scale;
    /* wl_surface.set_buffer_scale, double-buffered like every other surface
     * property. 1 until a client says otherwise, so a client that never sends
     * it keeps buffer pixels == logical pixels. */
    int32_t buffer_scale, pending_buffer_scale;
    /* The scale the BUFFER_SCALE marker last reported, 0 before the first
     * commit. A bar commits a frame a second, so the marker fires on a change,
     * not on every commit. */
    int32_t reported_scale;
    /* The buffer size the GLBUFFER marker last reported. */
    int32_t reported_bw, reported_bh;
    /* Set once wl_surface.enter has named the output to this surface. One
     * output means one enter, so this keeps the two senders from doubling it. */
    int entered;
    int gl_drawn;                       /* GLDRAW marker printed */
};

/* ---- wl_shm pool / buffer (custom, gbm-backed) ------------------------- */

/* libwayland's built-in wl_shm mmaps the client's pool fd directly, but on
 * this kernel a plain file/memfd mmap is NOT shared across processes — only
 * the DRI bo registry is (host SharedArrayBuffer). So the client backs its
 * pool with a renderD128 dumb-bo and passes its prime-fd; we import that
 * prime-fd via gbm and map it, aliasing the same shared bytes. This is the
 * "gbm_bo_import path for wl_shm" the plan names (§8.1). Buffers may sit
 * at any offset in the pool; the formats are XRGB/ARGB8888. */
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
    int import_failed;      /* the import is a property of the pool fd, so a
                             * failure is final — retrying it once per frame
                             * would flood the log and stall the desktop. */
    void *map_data;
    uint32_t *pixels;       /* shared mapping of the client's bytes */
    uint32_t map_stride_px;
    /* linux-dmabuf Y_INVERT: row 0 is the bottom of the image. A GL
     * producer (libwayland-egl) renders into a framebuffer, whose rows are
     * stored bottom-up; CPU-drawn buffers are top-down. */
    int y_invert;
    /* GPU path: the bo imported on the EGL fd + its texture. gl_dirty is
     * set on every commit of this buffer so the next GL repaint rebinds
     * (= re-uploads) only surfaces whose content actually changed. */
    unsigned egl_bo_handle;
    unsigned gl_tex;
    int gl_dirty;
};

/* ---- compositor singleton ---------------------------------------------- */

struct kwlctl_conn;   /* one control-socket connection (defined with the IPC) */

/* One hyprland_global_shortcut_v1: a client asked the compositor to own a
 * key combination for it and report presses, the way Quickshell's
 * GlobalShortcut does under Hyprland. */
struct global_shortcut {
    struct wl_resource *resource;
    char app_id[64];
    char id[64];
    struct wl_list link;
};

/* One ext_idle_notification_v1: idles when no input arrives for timeout_ms,
 * resumes on the next input. */
struct idle_notification {
    struct wl_resource *resource;
    uint32_t timeout_ms;
    int idled;
    struct wl_event_source *timer;
    struct wl_list link;
};

/* An output-space rectangle: a tile, or the work area left over once the
 * anchored layer surfaces have taken their exclusive zones. */
struct geom { int x, y, w, h; };

struct compositor {
    struct wl_display *display;
    struct wl_event_loop *loop;

    /* DRM / KMS scanout. */
    int card_fd;
    uint32_t crtc_id;
    uint32_t connector_id;
    drmModeModeInfo mode;
    /* Two grids. `pw`/`ph` are the mode: one unit per device pixel, and what
     * every scanout, GBM bo, EGL surface and GL viewport is sized in.
     * `width`/`height` are the logical grid clients lay out in — `pw`/`ph`
     * divided by `scale`. They are equal at scale 1, which is why every
     * layout site still reads width/height. */
    uint32_t pw, ph;
    uint32_t width, height;
    /* wl_output scale: device pixels per logical pixel (WLC_SCALE, else
     * derived from the connector's physical size, else 1). A client that honours wl_surface.set_buffer_scale attaches a
     * buffer this many times larger than its logical size and blits 1:1; one
     * that ignores it is upscaled — soft, but correctly sized. */
    uint32_t scale;
    int scale_explicit;   /* WLC_SCALE set it; do not derive from DPI */
    /* The connector's physical size in millimetres, 0 when unknown. It is
     * what wl_output.geometry reports, so a client that sizes its UI by DPI
     * (SDL's Wayland backend, and so ScummVM) sees the real display. */
    int32_t mm_width, mm_height;
    struct gbm_device *gbm;
    struct gbm_surface *gbm_surface;
    struct gbm_bo *displayed_bo;   /* on-screen right now */
    struct gbm_bo *pending_bo;     /* flip queued, not yet complete */
    int crtc_configured;           /* SetCrtc done once */

    /* Pre-rendered desktop background (pw × ph, tightly packed). */
    uint32_t *wallpaper;

    /* Input. */
    struct libinput *li;
    uint32_t xkb_keymap_size;
    struct xkb_state *xkb_state;   /* compositor-side modifier tracking */
    uint32_t sent_mods_depressed, sent_mods_latched, sent_mods_locked,
             sent_group;
    double cursor_x, cursor_y;
    int buttons_down;
    /* Serial of the press that began the current implicit pointer grab.
     * xdg_toplevel.move must quote it -- see toplevel_move. */
    uint32_t press_serial;

    /* Window management. Both arrays grow with the number of live surfaces
     * -- there is no fixed cap for one client to exhaust and starve every
     * other client of windows. zorder's capacity is reserved alongside
     * all_surfaces at creation (a surface is in zorder at most once), so
     * mapping never needs to allocate or fail. */
    struct surface **zorder;               /* bottom → top */
    int n_surfaces;
    /* Every live surface, mapped or not. buffer_resource_destroy must
     * clear buffer references on surfaces that never mapped (attach →
     * wl_buffer.destroy → commit is protocol-legal) and those are absent
     * from zorder. */
    struct surface **all_surfaces;
    int n_all_surfaces;
    int surfaces_cap;                      /* capacity of both arrays */
    struct surface *kbd_focus;
    struct surface *ptr_focus;

    /* Mapped layer surfaces, in map order; composited by layer, not by
     * z-order, and never tiled. `usable` is the output minus their
     * exclusive zones — the area retile() partitions. */
    /* Mapped wlr-layer-shell surfaces (bar, launcher). Grown on demand like
     * the z-order: a fixed array silently dropped surfaces past its cap. */
    struct surface **layers;
    int layers_cap;
    int n_layers;
    struct geom usable;

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

    /* hyprland-global-shortcuts: what clients registered, by app_id and id;
     * a `global` bind fires the matching one. The release goes to the
     * shortcut the press went to, whatever the modifiers are by then. */
    struct wl_list shortcuts;
    struct global_shortcut *shortcut_pressed;
    uint32_t shortcut_key;

    /* ext-idle-notify: one timer per notification, restarted by any input. */
    struct wl_list idle_notifications;

    /* Bound seat resources (across all clients; routed per-client). */
    /* Every bound wl_keyboard / wl_pointer / wl_output, linked through
     * wl_resource_get_link. Lists, not fixed arrays: a capped array
     * silently stopped tracking resources once full, so one client binding
     * enough of them left every other client's window without input.
     * Outputs are tracked for wl_surface.enter at map time -- a DPI-aware
     * client (foot) sizes its fonts only after entering an output. */
    struct wl_list keyboards;
    struct wl_list pointers;
    struct wl_list outputs;

    int client_count;
    int had_client;   /* so we only exit after a client has actually connected */
    int repaint_needed;
    int in_input_batch; /* draining libinput events; defer repaints to the end */
    int sampled;      /* printed the one-shot composite sample */
};

static struct compositor g;

/* ---- theme ------------------------------------------------------------- */

/* The live palette plus the list of installed themes, so `kwlctl dispatch
 * theme next` can cycle them the way Omarchy's theme-next binding does. The
 * defaults are the look the desktop had before themes existed, which is what
 * an install with no theme directory keeps. */
static struct {
    char name[32];
    uint32_t border_active;
    uint32_t wallpaper_top, wallpaper_bottom;
    char wallpaper_path[256];    /* KWLP raw image; "" = gradient */
    int gaps_in, gaps_out;
    char installed[MAX_THEMES][32];
    int n_installed;
    int current;                 /* index into installed, -1 when unthemed */
    char notify[256];            /* `notify =` config: spawned on a switch */
} th = {
    .name = "default",
    .border_active = FOCUS_COLOR,
    .wallpaper_top = 0xff10121au,
    .wallpaper_bottom = 0xff1b2233u,
    .gaps_in = 8,
    .gaps_out = 12,
    .current = -1,
};

/* ---- session lock -------------------------------------------------------- */

/* ext-session-lock: while `locked`, every frame is the lock surface over an
 * opaque black output, and input reaches nothing else. A lock client that
 * dies leaves the session locked (the protocol forbids unlocking for it);
 * the next lock request takes the session over. */
static struct {
    struct wl_resource *lock;      /* the ext_session_lock_v1 holding the session */
    int locked;
    int announce;                  /* send `locked` once a blanked frame flipped */
    struct surface *role_surface;  /* the surface holding the lock-surface role */
    struct surface *surface;       /* that surface once it mapped */
} lk;

/* ---- GPU compositing state (GLES via renderD128) ----------------------- */

static struct {
    int active;                 /* GL probed OK; repaints render on the GPU */
    EGLDisplay dpy;
    EGLContext ctx;
    EGLSurface srf;
    GLuint prog;
    GLint loc_rect;             /* vec4 NDC x0,y0(top),x1,y1(bottom) */
    GLint loc_uv;               /* vec4 texture uv0.xy,uv1.xy */
    GLint loc_use_tex;          /* 0 = flat u_color; see glc_tex_mode */
    GLint loc_color;
    unsigned wallpaper_tex;
} glc;

static uint32_t now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint32_t)(ts.tv_sec * 1000u + ts.tv_nsec / 1000000u);
}

/* Walk the seat resources on `list` that belong to `client`. Declares `res`
 * for the loop body; the `continue; else` form keeps a single following
 * statement or block correctly bound. Destroy handlers unlink each resource,
 * so a disconnected client's resource is never sent to. */
#define for_each_seat_res(res, list, client)                               \
    for (struct wl_resource *res = wl_resource_from_link((list)->next);    \
         wl_resource_get_link(res) != (list);                              \
         res = wl_resource_from_link(wl_resource_get_link(res)->next))     \
        if (wl_resource_get_client(res) != (client)) continue; else

static void schedule_repaint(void);
static void kbd_set_focus(struct surface *s);
static void ptr_refresh_focus(void);
static void send_surface_enter(struct surface *s);
static int layer_in_band(const struct surface *s, int above);

/* A v5 pointer client applies state on the frame event; end every burst. */
static void ptr_send_frame(struct wl_resource *p) {
    if (wl_resource_get_version(p) >= WL_POINTER_FRAME_SINCE_VERSION)
        wl_pointer_send_frame(p);
}
static int theme_switch(const char *arg);
static void idle_activity(void);
static void lock_focus_restore(void);
static void shortcut_send(struct global_shortcut *sc, int pressed);
static void global_shortcut_press(const char *param, uint32_t key);
static void kwlctl_emit(const char *fmt, ...);
static void kwlctl_exec(char *args);
static void workspaces_sync(void);
static void selection_send_to_client(struct wl_client *client);

/* A surface participates in compositing, input, and tiling only when it is
 * mapped AND on the active workspace. A layer surface is a shell component,
 * so it shows on every workspace. A subsurface shows with its parent. */
static int surface_visible(const struct surface *s) {
    if (s->parent) return s->mapped && surface_visible(s->parent);
    if (s->layer_surface || s->lock_surface) return s->mapped;
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
    /* Capacity reserved at creation: n_surfaces < n_all_surfaces <= cap. */
    g.zorder[g.n_surfaces++] = s;
}

/* Make room for one more live surface in all_surfaces and zorder. */
static int reserve_surface_slot(void) {
    if (g.n_all_surfaces < g.surfaces_cap) return 1;
    int cap = g.surfaces_cap ? g.surfaces_cap * 2 : 16;
    struct surface **all = realloc(g.all_surfaces, (size_t)cap * sizeof *all);
    if (!all) return 0;
    g.all_surfaces = all;
    struct surface **z = realloc(g.zorder, (size_t)cap * sizeof *z);
    if (!z) return 0;
    g.zorder = z;
    g.surfaces_cap = cap;
    return 1;
}
static void zorder_remove(struct surface *s) {
    int i = 0;
    while (i < g.n_surfaces && g.zorder[i] != s) i++;
    if (i == g.n_surfaces) return;
    for (; i + 1 < g.n_surfaces; i++) g.zorder[i] = g.zorder[i + 1];
    g.n_surfaces--;
}
/* `g.zorder` is the window stack; a layer surface belongs to `g.layers`, where
 * layer_place() owns its geometry and its layer fixes its depth. surface_at()
 * returns layer surfaces so a click reaches the bar, and click-to-focus raises
 * whatever it returns — so clicking Waybar would otherwise push the bar into
 * the window stack, where retile() hands it a tile: the whole usable area
 * whenever the workspace holds no windows. */
static void zorder_raise(struct surface *s) {
    if (s->layer_surface || s->lock_surface) return;
    if (g.n_surfaces && g.zorder[g.n_surfaces - 1] == s) return;
    zorder_remove(s);
    zorder_add(s);
    schedule_repaint();
}

static int surface_contains(const struct surface *s, double x, double y) {
    return x >= s->x && x < s->x + s->w && y >= s->y && y < s->y + s->h;
}

/* Topmost mapped surface containing the output-space point, or NULL. The
 * compositing order decides: overlay/top layer surfaces first, then windows,
 * then the background/bottom layers. */
static struct surface *surface_at(double x, double y) {
    if (lk.locked) {
        if (lk.surface && surface_contains(lk.surface, x, y)) return lk.surface;
        return NULL;
    }
    for (int i = g.n_layers - 1; i >= 0; i--)
        if (layer_in_band(g.layers[i], 1) && surface_contains(g.layers[i], x, y))
            return g.layers[i];
    for (int i = g.n_surfaces - 1; i >= 0; i--) {
        struct surface *s = g.zorder[i];
        if (surface_visible(s) && surface_contains(s, x, y)) return s;
    }
    for (int i = g.n_layers - 1; i >= 0; i--)
        if (layer_in_band(g.layers[i], 0) && surface_contains(g.layers[i], x, y))
            return g.layers[i];
    return NULL;
}

/* ---- window placement --------------------------------------------------- */

/* Demo-layout slots by app_id, cascade fallback. Placement policy is the
 * compositor's job in Wayland (clients cannot position themselves); a rule
 * table keyed on app_id is the same mechanism real WMs use for window
 * rules. x ≥ 0 anchors to the LEFT edge; x < 0 anchors to the RIGHT edge
 * (window's left edge at the logical width + x), so edge anchoring spreads
 * the demo across the full desktop whatever the mode is; on a 1920-wide
 * logical grid the resolved coordinates are exactly the original fixed
 * layout (wlclock 1240, wlpaint 1080). The logical grid can be narrower
 * than a rule's offset, so every result is clamped into the work area
 * below. */
static const struct { const char *app_id; int x, y; } placement_rules[] = {
    { "wlterm",           90, 120 },
    { "wlclock", 1240 - 1920, 110 },   /* width - 680 */
    { "wlpaint", 1080 - 1920, 560 },   /* width - 840 */
};

static void place_surface(struct surface *s) {
    static int cascade;
    int x = 0, y = 0, matched = 0;
    for (size_t i = 0; i < sizeof(placement_rules) / sizeof(placement_rules[0]); i++) {
        if (strcmp(s->app_id, placement_rules[i].app_id) == 0) {
            x = placement_rules[i].x;
            y = placement_rules[i].y;
            /* Right-anchored rule: resolve against the live logical width.
             * A grid narrower than the offset resolves left of 0, which the
             * work-area clamp below pulls back on screen. */
            if (x < 0) x += (int)g.width;
            matched = 1;
            break;
        }
    }
    if (!matched) {
        x = 160 + (cascade % 5) * 72;
        y = 120 + (cascade % 5) * 56;
        cascade++;
    }
    /* Clamp into the work area, so a floating window never opens under an
     * anchored bar (with no layer surfaces the work area IS the output). */
    if (x + s->w > g.usable.x + g.usable.w) x = g.usable.x + g.usable.w - s->w - 16;
    if (y + s->h > g.usable.y + g.usable.h) y = g.usable.y + g.usable.h - s->h - 16;
    if (x < g.usable.x) x = g.usable.x;
    if (y < g.usable.y) y = g.usable.y;
    s->x = x;
    s->y = y;
    s->placed = 1;
}

/* ---- wlr-layer-shell arrangement ---------------------------------------- */

/* Layer surfaces are shell components (bar, launcher, wallpaper), not windows:
 * the compositor anchors each one to output edges and lets it reserve an
 * exclusive strip that windows must not cover. Everything below computes that
 * from the double-buffered state the client set, in the protocol's order —
 * background first, overlay last — so an earlier layer's exclusive zone
 * shrinks the area a later one anchors against. */

static void layer_add(struct surface *s) {
    if (g.n_layers == g.layers_cap) {
        int cap = g.layers_cap ? g.layers_cap * 2 : 8;
        struct surface **l = realloc(g.layers, (size_t)cap * sizeof *l);
        if (!l) {
            wl_resource_post_no_memory(s->layer_surface);
            return;
        }
        g.layers = l;
        g.layers_cap = cap;
    }
    g.layers[g.n_layers++] = s;
}

static void layer_remove(struct surface *s) {
    int i = 0;
    while (i < g.n_layers && g.layers[i] != s) i++;
    if (i == g.n_layers) return;
    for (; i + 1 < g.n_layers; i++) g.layers[i] = g.layers[i + 1];
    g.n_layers--;
}

/* The topmost mapped layer surface that asked for exclusive keyboard focus
 * (the launcher), or NULL. Overlay wins over top, then map order. */
static struct surface *layer_kb_grab(void) {
    struct surface *best = NULL;
    for (int i = 0; i < g.n_layers; i++) {
        struct surface *s = g.layers[i];
        if (!s->mapped ||
            s->kb_interactive != ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_EXCLUSIVE)
            continue;
        if (!best || s->layer >= best->layer) best = s;
    }
    return best;
}

/* Anchor one layer surface inside `area` and, when it reserves an exclusive
 * zone on a single edge, shrink `area` by that strip for the surfaces
 * arranged after it and for the window layout. */
static void layer_place(struct surface *s, struct geom *area) {
    const uint32_t top = ZWLR_LAYER_SURFACE_V1_ANCHOR_TOP;
    const uint32_t bottom = ZWLR_LAYER_SURFACE_V1_ANCHOR_BOTTOM;
    const uint32_t left = ZWLR_LAYER_SURFACE_V1_ANCHOR_LEFT;
    const uint32_t right = ZWLR_LAYER_SURFACE_V1_ANCHOR_RIGHT;

    int span_x = (s->anchor & left) && (s->anchor & right);
    int span_y = (s->anchor & top) && (s->anchor & bottom);

    /* A 0 dimension means "you decide", which the protocol only allows when
     * the surface spans that axis: it then fills the area minus its margins. */
    int w = s->req_w > 0 ? s->req_w
                         : area->w - s->margin_left - s->margin_right;
    int h = s->req_h > 0 ? s->req_h
                         : area->h - s->margin_top - s->margin_bottom;
    if (w < 1) w = 1;
    if (h < 1) h = 1;
    if (w > area->w) w = area->w;
    if (h > area->h) h = area->h;

    int x, y;
    if ((s->anchor & left) && !span_x)       x = area->x + s->margin_left;
    else if ((s->anchor & right) && !span_x) x = area->x + area->w - w - s->margin_right;
    else                                     x = area->x + (area->w - w) / 2;
    if ((s->anchor & top) && !span_y)        y = area->y + s->margin_top;
    else if ((s->anchor & bottom) && !span_y) y = area->y + area->h - h - s->margin_bottom;
    else                                     y = area->y + (area->h - h) / 2;

    s->x = x;
    s->y = y;
    s->w = w;
    s->h = h;
    s->placed = 1;

    /* Only an edge-anchored strip of a MAPPED surface reserves space; a corner
     * or a full-screen anchor is treated as zero, per the protocol. A surface
     * that has a role but has never committed a buffer holds nothing back, so
     * a client that dies mid-handshake cannot strand a strip of the desktop. */
    if (s->exclusive_zone <= 0 || !s->mapped) return;
    if (span_x && !span_y && (s->anchor & top)) {
        int cut = s->exclusive_zone + s->margin_top;
        area->y += cut;
        area->h -= cut;
    } else if (span_x && !span_y && (s->anchor & bottom)) {
        area->h -= s->exclusive_zone + s->margin_bottom;
    } else if (span_y && !span_x && (s->anchor & left)) {
        int cut = s->exclusive_zone + s->margin_left;
        area->x += cut;
        area->w -= cut;
    } else if (span_y && !span_x && (s->anchor & right)) {
        area->w -= s->exclusive_zone + s->margin_right;
    }
    if (area->w < 1) area->w = 1;
    if (area->h < 1) area->h = 1;
}

static void retile(void);

/* Re-anchor every layer surface, recompute the window work area, and send each
 * client the size it must render at. Runs whenever a layer surface appears,
 * changes state, or goes away. */
static void layers_arrange(void) {
    struct geom area = { 0, 0, (int)g.width, (int)g.height };

    for (uint32_t layer = ZWLR_LAYER_SHELL_V1_LAYER_BACKGROUND;
         layer <= ZWLR_LAYER_SHELL_V1_LAYER_OVERLAY; layer++) {
        for (int i = 0; i < g.n_layers; i++) {
            struct surface *s = g.layers[i];
            if (s->layer != layer) continue;
            int32_t prev_w = s->w, prev_h = s->h;
            layer_place(s, &area);
            int resized = (s->w != prev_w || s->h != prev_h);
            if (!s->layer_configured || resized) {
                zwlr_layer_surface_v1_send_configure(
                    s->layer_surface, wl_display_next_serial(g.display),
                    (uint32_t)s->w, (uint32_t)s->h);
                s->layer_configured = 1;
            }
            /* The marker says the strip is live. A layer surface reserves
             * nothing until it maps, so announcing it at configure time
             * would put it ahead of the windows re-tiling under it. */
            if (s->mapped && (!s->layer_announced || resized)) {
                printf("LAYER ns=%s layer=%u x=%d y=%d w=%d h=%d\n", s->app_id,
                       s->layer, s->x, s->y, s->w, s->h);
                fflush(stdout);
                s->layer_announced = 1;
            }
        }
    }

    g.usable = area;
    retile();
    schedule_repaint();
}

/* ---- tiling layout ------------------------------------------------------ */

/* FLOATING (default, zero-initialised) keeps the app_id placement rules that
 * /?demo=wayland depends on. DWINDLE dictates geometry to clients: the desktop
 * becomes the tiling mode of the same compositor. Selected by WLC_LAYOUT. */
enum layout_mode { LAYOUT_FLOATING = 0, LAYOUT_DWINDLE };

/* Gaps in output pixels. OUTER insets the whole tiling area from the screen
 * edge; INNER separates adjacent windows. Theme-driven (theme_apply). */
static int tile_gap_outer = 12;
static int tile_gap_inner = 8;

/* Dwindle tiler: at each step split the remaining region along its LONGER
 * side (Hyprland's default). Its only inputs are the arguments and the two
 * gap sizes, so the smoke gate predicts the exact partition and checks it
 * against the emitted geometry. */
static void compute_tiling(struct geom area, int n, struct geom *out) {
    if (n <= 0) return;
    area.x += tile_gap_outer;
    area.y += tile_gap_outer;
    area.w -= 2 * tile_gap_outer;
    area.h -= 2 * tile_gap_outer;
    if (area.w < 1) area.w = 1;
    if (area.h < 1) area.h = 1;

    struct geom region = area;
    for (int i = 0; i < n; i++) {
        if (i == n - 1) { out[i] = region; break; }
        struct geom near = region, rest = region;
        if (region.w >= region.h) {          /* wider than tall: split L|R */
            int half = (region.w - tile_gap_inner) / 2;
            if (half < 1) half = 1;
            near.w = half;
            rest.x = region.x + half + tile_gap_inner;
            rest.w = region.w - half - tile_gap_inner;
        } else {                             /* taller than wide: split T/B */
            int half = (region.h - tile_gap_inner) / 2;
            if (half < 1) half = 1;
            near.h = half;
            rest.y = region.y + half + tile_gap_inner;
            rest.h = region.h - half - tile_gap_inner;
        }
        out[i] = near;
        region = rest;
    }
}

/* Send an xdg_surface.configure for this toplevel's role and remember the
 * serial until the client acks it (or a later one). */
static void surface_send_xdg_configure(struct surface *s) {
    uint32_t serial = wl_display_next_serial(g.display);
    uint32_t *slot = wl_array_add(&s->pending_serials, sizeof serial);
    if (!slot) {
        wl_resource_post_no_memory(s->xdg_surface);
        return;
    }
    *slot = serial;
    s->configure_serial = serial;
    xdg_surface_send_configure(s->xdg_surface, serial);
}

/* Recompute geometry for every mapped toplevel (in map order = z-order) and
 * push it to each client through the xdg configure path. A no-op in FLOATING
 * mode, so the app_id placement path is untouched. Emits one TILE marker per
 * window for the smoke gate to verify the partition. */
static void retile(void) {
    if (g.layout == LAYOUT_FLOATING) return;

    int n = 0;
    for (int i = 0; i < g.n_surfaces; i++)
        if (surface_visible(g.zorder[i])) n++;
    if (n == 0) return;
    /* Sized from the live window count: the surface list has no cap, so a
     * fixed array here overflowed the stack past its length. */
    struct surface **tiled = malloc((size_t)n * sizeof *tiled);
    struct geom *geoms = malloc((size_t)n * sizeof *geoms);
    if (!tiled || !geoms) {
        /* Keep the previous layout rather than tile a partial set. */
        free(tiled);
        free(geoms);
        return;
    }
    n = 0;
    for (int i = 0; i < g.n_surfaces; i++)
        if (surface_visible(g.zorder[i])) tiled[n++] = g.zorder[i];
    compute_tiling(g.usable, n, geoms);

    for (int i = 0; i < n; i++) {
        struct surface *s = tiled[i];
        s->x = geoms[i].x;
        s->y = geoms[i].y;
        s->w = geoms[i].w;
        s->h = geoms[i].h;
        s->placed = 1;
        /* ACTIVATED plus, for clients that bound xdg-shell v2, all four
         * TILED_* edges: a tiled window is constrained on every side, as
         * Hyprland reports it. The tiled states are what tell a client the
         * size is not a suggestion — SDL, for one, keeps a fixed-size
         * window's own size for any configure it considers floating. */
        if (s->xdg_toplevel && s->xdg_surface) {
            struct wl_array states;
            wl_array_init(&states);
            uint32_t *st = wl_array_add(&states, sizeof(uint32_t));
            if (st) *st = XDG_TOPLEVEL_STATE_ACTIVATED;
            if (wl_resource_get_version(s->xdg_toplevel) >=
                XDG_TOPLEVEL_STATE_TILED_LEFT_SINCE_VERSION) {
                static const uint32_t edges[] = {
                    XDG_TOPLEVEL_STATE_TILED_LEFT, XDG_TOPLEVEL_STATE_TILED_RIGHT,
                    XDG_TOPLEVEL_STATE_TILED_TOP, XDG_TOPLEVEL_STATE_TILED_BOTTOM,
                };
                for (size_t k = 0; k < sizeof edges / sizeof *edges; k++) {
                    uint32_t *t = wl_array_add(&states, sizeof(uint32_t));
                    if (t) *t = edges[k];
                }
            }
            xdg_toplevel_send_configure(s->xdg_toplevel, s->w, s->h, &states);
            wl_array_release(&states);
            surface_send_xdg_configure(s);
        }
        printf("TILE n=%d i=%d x=%d y=%d w=%d h=%d\n",
               n, i, s->x, s->y, s->w, s->h);
    }
    free(tiled);
    free(geoms);
    fflush(stdout);
    schedule_repaint();
}

/* ====================================================================== */
/* wl_surface                                                             */
/* ====================================================================== */

static void surface_destroy(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
/* Take a mapped surface off screen: out of the z-order and out of every focus
 * and grab. Focus moves through the normal setters, so the surface's client
 * gets its leave events and the next window its enter -- unlike
 * surface_resource_destroy, whose resource is mid-teardown and must not be
 * named in an event. The buffer goes back to the client. */
static void unmap_surface(struct surface *s) {
    if (!s->mapped) return;
    if (g.grab == s) g.grab = NULL;
    zorder_remove(s);
    s->mapped = 0;
    if (s->buffer) {
        wl_buffer_send_release(s->buffer);
        s->buffer = NULL;
    }
    if (g.kbd_focus == s)
        kbd_set_focus(g.n_surfaces ? g.zorder[g.n_surfaces - 1] : NULL);
    if (g.ptr_focus == s) ptr_refresh_focus();
    schedule_repaint();
}

static void surface_attach(struct wl_client *c, struct wl_resource *r,
                           struct wl_resource *buffer, int32_t x, int32_t y) {
    struct surface *s = wl_resource_get_user_data(r);
    s->pending_buffer = buffer;
    s->pending_attached = 1;
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
/* The on-screen size of a committed buffer, per wp_viewporter's surface-size
 * rules: the destination wins, then an integral source rect, then the buffer
 * dims. */
static void surface_committed_size(struct surface *s, struct shm_buffer *b,
                                   int32_t *w, int32_t *h) {
    if (s->vp_dst_w > 0) {
        *w = s->vp_dst_w;
        *h = s->vp_dst_h;
        return;
    }
    if (s->vp_src_w > 0) {
        *w = wl_fixed_to_int(s->vp_src_w);
        *h = wl_fixed_to_int(s->vp_src_h);
        return;
    }
    /* Without a viewport the surface is its buffer divided by the scale the
     * client declared: a scale-2 client attaches twice the pixels for the
     * same logical box. wp_viewporter's destination is already logical, so
     * both returns above are scale-independent. */
    *w = b->width / s->buffer_scale;
    *h = b->height / s->buffer_scale;
}

static void surface_commit(struct wl_client *c, struct wl_resource *r) {
    struct surface *s = wl_resource_get_user_data(r);
    /* A layer surface's shell state — size, anchor, margins, exclusive zone —
     * is double-buffered like every other surface property: the requests are
     * recorded and take effect here. The first commit carries no buffer and
     * exists only to fetch the configure that says what size to render, but it
     * is not the last one that matters: mako sends a second set_size once it
     * knows the output scale, and it will not draw until the configure for that
     * one comes back. */
    if (s->layer_surface && (s->layer_dirty || !s->layer_configured)) {
        s->layer_dirty = 0;
        send_surface_enter(s);
        layers_arrange();
    }
    s->buffer_scale = s->pending_buffer_scale;
    if (!s->pending_attached) { schedule_repaint(); return; }
    s->pending_attached = 0;
    /* attach(NULL) + commit is how a client hides its surface. (A pending
     * buffer destroyed before commit also lands here, as in Weston.) */
    if (!s->pending_buffer) {
        if (s->lock_surface) {
            wl_resource_post_error(s->lock_surface,
                                   EXT_SESSION_LOCK_SURFACE_V1_ERROR_NULL_BUFFER,
                                   "lock surface committed with no buffer");
            return;
        }
        unmap_surface(s);
        return;
    }

    /* Only an xdg_toplevel whose configure the client has acked may show a
     * buffer. xdg-shell makes a buffer before that a client error; a
     * surface with no shell role simply is not displayed (it may take a
     * role later) -- it must not appear on the desktop or take focus. */
    if (s->xdg_surface && !s->xdg_toplevel) {
        wl_resource_post_error(s->xdg_surface, XDG_SURFACE_ERROR_NOT_CONSTRUCTED,
                               "buffer committed to an xdg_surface with no role");
        return;
    }
    if (s->xdg_toplevel && !s->configured) {
        wl_resource_post_error(s->xdg_surface, XDG_SURFACE_ERROR_UNCONFIGURED_BUFFER,
                               "buffer committed before ack_configure");
        return;
    }

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
        int32_t w, h;
        surface_committed_size(s, b, &w, &h);
        /* A layer surface renders sharp on the same terms as a window, so the
         * marker names the client and covers both roles. The first commit
         * always reports (reported_scale starts at 0), because the scale a
         * client picks for its FIRST frame is the one that decides whether a
         * short-lived surface is ever sharp. */
        if (s->buffer_scale != s->reported_scale) {
            s->reported_scale = s->buffer_scale;
            printf("BUFFER_SCALE app=%s scale=%d bw=%d bh=%d w=%d h=%d\n",
                   s->app_id, s->buffer_scale, b->width, b->height, w, h);
            fflush(stdout);
        }
        /* A GL client's buffer size, reported when it changes: it is how a
         * gate sees that the client really reallocated for the size it was
         * configured to (a tiled GL client that keeps its first buffer draws
         * cropped, and no other marker changes). Only buffers rendered by GL
         * -- the ones libwayland-egl marks Y_INVERT -- are reported: shm
         * clients resize on every retile, and one line per window per theme
         * switch would scroll the markers other gates read off the screen. */
        if (s->xdg_toplevel && b->y_invert &&
            (b->width != s->reported_bw || b->height != s->reported_bh)) {
            s->reported_bw = b->width;
            s->reported_bh = b->height;
            printf("GLBUFFER app=%s bw=%d bh=%d\n", s->app_id,
                   b->width, b->height);
            fflush(stdout);
        }
        /* The compositor dictates a layer surface's box, so its geometry comes
         * from the arrangement, not from whatever the client attached. */
        if (!s->layer_surface) {
            if (s->viewport && (w != s->w || h != s->h)) {
                printf("VIEWPORT bw=%d bh=%d w=%d h=%d\n",
                       b->width, b->height, w, h);
                fflush(stdout);
            }
            s->w = w;
            s->h = h;
        }
        b->gl_dirty = 1;   /* GPU path re-uploads this buffer's texture */
    }

    /* A subsurface maps with its buffer and rides its parent — no tiling,
     * no focus, no z-order entry of its own. */
    if (s->parent) {
        s->mapped = 1;
        schedule_repaint();
        return;
    }

    /* A lock surface must have acked the configure and must match the
     * output exactly; both are protocol errors otherwise. */
    if (s->lock_surface) {
        if (!s->lock_acked) {
            wl_resource_post_error(
                s->lock_surface,
                EXT_SESSION_LOCK_SURFACE_V1_ERROR_COMMIT_BEFORE_FIRST_ACK,
                "lock surface committed before ack_configure");
            return;
        }
        if (s->w != (int32_t)g.width || s->h != (int32_t)g.height) {
            wl_resource_post_error(
                s->lock_surface,
                EXT_SESSION_LOCK_SURFACE_V1_ERROR_DIMENSIONS_MISMATCH,
                "lock surface is %dx%d, output is %ux%u", s->w, s->h,
                g.width, g.height);
            return;
        }
        if (!s->mapped) {
            s->mapped = 1;
            send_surface_enter(s);
            lk.surface = s;
            if (lk.locked) {
                kbd_set_focus(s);
                ptr_refresh_focus();
            }
            printf("LOCK_SURFACE w=%d h=%d\n", s->w, s->h);
            fflush(stdout);
        }
        schedule_repaint();
        return;
    }

    if (s->layer_surface) {
        if (!s->mapped) {
            s->mapped = 1;
            send_surface_enter(s);
            /* Now that it is mapped its exclusive zone counts, so the windows
             * below re-tile around it. */
            layers_arrange();
            /* A launcher-style surface asks for the keyboard and gets it for
             * as long as it lives. */
            if (s->kb_interactive ==
                    ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_EXCLUSIVE &&
                !lk.locked)
                kbd_set_focus(s);
            ptr_refresh_focus();
        }
        schedule_repaint();
        return;
    }

    /* Only the xdg_toplevel role makes a surface a window. A client's cursor
     * surface (wl_pointer.set_cursor, which we accept and ignore) carries a
     * buffer under no role: Waybar's would otherwise map, take the keyboard,
     * and claim a tile. */
    if (!s->xdg_toplevel) { schedule_repaint(); return; }

    if (!s->mapped) {
        s->mapped = 1;
        send_surface_enter(s);
        if (!s->workspace) s->workspace = g.active_ws;   /* opens on the visible ws */
        /* Tiling dictates geometry for every window in retile(); only the
         * floating desktop places individually by app_id. */
        if (g.layout == LAYOUT_FLOATING && !s->placed) place_surface(s);
        zorder_raise(s);
        /* Hyprland's order: the workspace exists, the window opens, then it
         * takes focus. Quickshell's IPC module creates an untitled toplevel
         * for an `activewindowv2` it has not seen an `openwindow` for. */
        workspaces_sync();
        kwlctl_emit("openwindow>>%p,%d,%s,%s", (void *)s, s->workspace,
                    s->app_id, s->title);
        /* A newly mapped window takes keyboard focus (and pointer focus if
         * the cursor happens to be over it) — unless a layer surface holds
         * the keyboard exclusively. A window that maps while the launcher
         * is open would otherwise swallow the keys typed into it. */
        if (!layer_kb_grab() && !lk.locked) kbd_set_focus(s);
        ptr_refresh_focus();
        retile();   /* no-op when floating */
    }
    schedule_repaint();
}
static void surface_set_buffer_transform(struct wl_client *c,
                                         struct wl_resource *r, int32_t t) {}
static void surface_set_buffer_scale(struct wl_client *c, struct wl_resource *r,
                                     int32_t scale) {
    if (scale < 1) {
        wl_resource_post_error(r, WL_SURFACE_ERROR_INVALID_SCALE,
                               "buffer scale %d is not positive", scale);
        return;
    }
    struct surface *s = wl_resource_get_user_data(r);
    if (s) s->pending_buffer_scale = scale;
}
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
    /* A client may destroy the wl_surface before its layer_surface; drop the
     * back-reference so that resource's destroy handler doesn't touch freed
     * memory. Same for a subsurface role, and for any children still glued
     * to this surface as their parent. */
    int was_layer = s->layer_surface != NULL;
    if (was_layer) {
        wl_resource_set_user_data(s->layer_surface, NULL);
        layer_remove(s);
    }
    if (s->subsurface) wl_resource_set_user_data(s->subsurface, NULL);
    if (s->lock_surface) {
        wl_resource_set_user_data(s->lock_surface, NULL);
        if (lk.surface == s) lk.surface = NULL;
        if (lk.role_surface == s) lk.role_surface = NULL;
    }
    if (s->viewport) wl_resource_set_user_data(s->viewport, NULL);
    if (s->fractional_scale)
        wl_resource_set_user_data(s->fractional_scale, NULL);
    for (int i = 0; i < g.n_all_surfaces; i++) {
        struct surface *c = g.all_surfaces[i];
        if (c->parent != s) continue;
        c->parent = NULL;
        c->mapped = 0;
    }
    if (g.kbd_focus == s) {
        g.kbd_focus = NULL;
        /* Hand focus to the new top window on the visible workspace, if any. */
        lock_focus_restore();
    }
    if (g.ptr_focus == s) g.ptr_focus = NULL;
    if (g.grab == s) g.grab = NULL;
    /* Clearing our references avoids a dangling send after destroy; the
     * callbacks themselves are owned by the client and freed with it. */
    s->n_frame_cbs = 0;
    /* xdg_surface/xdg_toplevel hold this surface as user_data and outlive it
     * whenever a client destroys wl_surface first — which libwayland permits.
     * Without this, xdg_toplevel.set_app_id writes into freed heap and
     * xdg_toplevel.move parks a dangling pointer in g.grab. Every xdg handler
     * already treats a NULL user_data as "no surface". */
    if (s->xdg_toplevel) wl_resource_set_user_data(s->xdg_toplevel, NULL);
    if (s->xdg_surface) wl_resource_set_user_data(s->xdg_surface, NULL);
    /* Pending presentation feedbacks would dangle on `s` through their
     * destructor's user_data; discard them now, before the free. */
    while (s->n_feedbacks > 0) {
        struct wl_resource *fb = s->feedbacks[--s->n_feedbacks];
        wl_resource_set_user_data(fb, NULL);
        wp_presentation_feedback_send_discarded(fb);
        wl_resource_destroy(fb);
    }
    int was_window = s->mapped && !was_layer && !s->parent;
    if (was_window) kwlctl_emit("closewindow>>%p", (void *)s);
    wl_array_release(&s->pending_serials);
    free(s);
    /* A closed window frees its slice back to the remaining tiles; a closed
     * layer surface additionally frees its exclusive strip. */
    if (was_layer) layers_arrange();
    else retile();   /* no-op when floating */
    if (was_window) workspaces_sync();
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
 * shared host buffer, so later reads see the client's latest pixels. A
 * buffer may sit at any offset in the pool (GTK packs several there), so
 * the import covers every row up to the buffer's end and the base pointer
 * walks to the buffer's own first row. */
static uint32_t *shm_buffer_pixels(struct shm_buffer *b, uint32_t *stride_px) {
    if (b->import_failed) return NULL;
    if (!b->bo) {
        uint32_t rows = (uint32_t)((b->offset + b->stride * b->height
                                    + b->stride - 1) / b->stride);
        struct gbm_import_fd_data d = {
            .fd = b->pool->fd,
            .width = (uint32_t)(b->stride / 4),
            .height = rows,
            .stride = (uint32_t)b->stride,
            .format = DRM_FORMAT_XRGB8888,
        };
        b->bo = gbm_bo_import(g.gbm, GBM_BO_IMPORT_FD, &d,
                              GBM_BO_USE_SCANOUT | GBM_BO_USE_LINEAR);
        if (!b->bo) {
            perror("gbm_bo_import");
            b->import_failed = 1;
            return NULL;
        }
        uint32_t ms = 0;
        unsigned char *base = gbm_bo_map(b->bo, 0, 0, d.width, rows, 0, &ms,
                                         &b->map_data);
        if (!base) {
            perror("gbm_bo_map");
            gbm_bo_destroy(b->bo);
            b->bo = NULL;
            b->import_failed = 1;
            return NULL;
        }
        /* The mapping's own stride is what separates its rows, so the
         * client's offset is walked as whole rows plus the remainder. */
        b->pixels = (uint32_t *)(base + (size_t)(b->offset / b->stride) * ms
                                 + (size_t)(b->offset % b->stride));
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
    /* GTK keeps several buffers in one pool and creates each at its own
     * offset, so only a buffer that leaves the pool is a protocol error. */
    if (offset < 0 || width <= 0 || height <= 0 || stride < width * 4 ||
        (int64_t)offset + (int64_t)stride * height > p->size) {
        wl_resource_post_error(r, WL_SHM_ERROR_INVALID_STRIDE,
                               "buffer does not fit in the pool");
        return;
    }
    if (format != WL_SHM_FORMAT_XRGB8888 && format != WL_SHM_FORMAT_ARGB8888) {
        wl_resource_post_error(r, WL_SHM_ERROR_INVALID_FORMAT,
                               "unsupported wl_shm format");
        return;
    }
    /* Geometry is untrusted client input, and the import maps exactly
     * stride * height bytes (libgbm_stub sets bo->size from the same two
     * numbers). blit_surface clips columns against the OUTPUT width, never
     * against the source stride, so a stride under width * 4 makes it memcpy
     * past the end of the mapping and composite the overrun onto the screen.
     * These are upstream wl_shm's own checks (wl_shm_pool_create_buffer). */
    if (width <= 0 || height <= 0) {
        wl_resource_post_error(r, WL_SHM_ERROR_INVALID_STRIDE,
                               "buffer size %dx%d is not positive",
                               width, height);
        return;
    }
    /* stride / 4 < width is stride < width * 4 without overflowing int32. */
    if (stride <= 0 || stride / 4 < width) {
        wl_resource_post_error(r, WL_SHM_ERROR_INVALID_STRIDE,
                               "stride %d is too small for width %d",
                               stride, width);
        return;
    }
    if ((int64_t)stride * (int64_t)height > (int64_t)p->size) {
        wl_resource_post_error(r, WL_SHM_ERROR_INVALID_STRIDE,
                               "stride %d x height %d overruns the %d-byte pool",
                               stride, height, p->size);
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
/* Size of the object behind a pool fd, or -1. Clients back pools with
 * dumb-bo prime fds, which report their size through lseek(SEEK_END) as a
 * Linux dma-buf does. The claimed pool size is client input; buffer
 * geometry is validated against it, so it must never exceed this. */
static off_t pool_backing_size(int fd) {
    off_t end = lseek(fd, 0, SEEK_END);
    if (end < 0) return -1;
    lseek(fd, 0, SEEK_SET);
    return end;
}

static void pool_resize(struct wl_client *c, struct wl_resource *r,
                        int32_t size) {
    struct shm_pool *p = wl_resource_get_user_data(r);
    if (size <= p->size) return;   /* pools only grow */
    /* A resize claims the fd's object grew; a dumb bo cannot, so a claim
     * past its real size would let create_buffer accept geometry the
     * import then reads beyond. */
    if ((off_t)size > pool_backing_size(p->fd)) {
        wl_resource_post_error(r, WL_SHM_ERROR_INVALID_FD,
                               "pool size %d exceeds the fd's object", size);
        return;
    }
    p->size = size;
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
    off_t backing = pool_backing_size(fd);
    if (size <= 0 || backing < 0 || (off_t)size > backing) {
        wl_resource_post_error(r, WL_SHM_ERROR_INVALID_FD,
                               "pool size %d does not fit the fd's object", size);
        close(fd);
        return;
    }
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
    if (format != DRM_FORMAT_XRGB8888 && format != DRM_FORMAT_ARGB8888 &&
        format != DRM_FORMAT_XBGR8888 && format != DRM_FORMAT_ABGR8888) {
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
    /* Y_INVERT is honoured (a GL producer's framebuffer is bottom-up);
     * interlaced/bottom_first do not apply to a progressive bo. */
    struct dmabuf_params *p = wl_resource_get_user_data(r);
    if (p->used) {
        wl_resource_post_error(r, ZWP_LINUX_BUFFER_PARAMS_V1_ERROR_ALREADY_USED,
                               "params already used");
        return;
    }
    p->used = 1;
    uint32_t err = 0;
    struct shm_buffer *b = dmabuf_make_buffer(c, p, width, height, format, &err);
    if (b) b->y_invert = (flags & ZWP_LINUX_BUFFER_PARAMS_V1_FLAGS_Y_INVERT) != 0;
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
    if (b) b->y_invert = (flags & ZWP_LINUX_BUFFER_PARAMS_V1_FLAGS_Y_INVERT) != 0;
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
     * only. The modifier event exists since interface version 3. The BGR
     * pair is the byte order of a GL RGBA texture, so a GL client's
     * GPU-tier bo is one of those (libwayland-egl). */
    static const uint32_t fmts[] = {
        DRM_FORMAT_XRGB8888, DRM_FORMAT_ARGB8888,
        DRM_FORMAT_XBGR8888, DRM_FORMAT_ABGR8888,
    };
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
     * invisible to buffer_resource_destroy's reference sweep. Only a real
     * allocation failure refuses; there is no fixed surface limit. */
    if (!reserve_surface_slot()) {
        wl_client_post_no_memory(client);
        return;
    }
    struct surface *s = calloc(1, sizeof(*s));
    if (!s) { wl_client_post_no_memory(client); return; }
    s->client = client;
    s->buffer_scale = s->pending_buffer_scale = 1;
    wl_array_init(&s->pending_serials);
    s->resource = wl_resource_create(client, &wl_surface_interface,
                                     wl_resource_get_version(resource), id);
    if (!s->resource) {
        wl_array_release(&s->pending_serials);
        free(s);
        wl_client_post_no_memory(client);
        return;
    }
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
    /* Clients draw their own titlebars (CSD); the server only relays the
     * title to the bar over the IPC sockets. */
    struct surface *s = wl_resource_get_user_data(r);
    if (!s || !title) return;
    if (strncmp(s->title, title, sizeof(s->title) - 1) == 0) return;
    snprintf(s->title, sizeof(s->title), "%s", title);
    if (!s->mapped) return;
    kwlctl_emit("windowtitle>>%p", (void *)s);
    kwlctl_emit("windowtitlev2>>%p,%s", (void *)s, s->title);
}
static void apply_window_rules(struct surface *s);
static void toplevel_set_app_id(struct wl_client *c, struct wl_resource *r,
                                const char *app_id) {
    struct surface *s = wl_resource_get_user_data(r);
    if (!s || !app_id) return;
    snprintf(s->app_id, sizeof(s->app_id), "%s", app_id);
    apply_window_rules(s);
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
    /* The move must continue the press the user made on THIS surface.
     * While a button is down, ptr_focus is pinned to the pressed surface
     * (the implicit grab), and that press's serial went only to its client.
     * Checking just "some button is down" let any client whose window was
     * merely mapped hijack a drag the user began on another window. */
    if (g.ptr_focus != s || serial != g.press_serial) return;
    g.grab = s;
    g.grab_dx = g.cursor_x - s->x;
    g.grab_dy = g.cursor_y - s->y;
    printf("MOVE_GRAB \"%s\"\n", s->app_id);
    fflush(stdout);
    zorder_raise(s);
    /* The pointer leaves the client for the duration of the grab. */
    if (g.ptr_focus) {
        uint32_t ser = wl_display_next_serial(g.display);
        for_each_seat_res(res, &g.pointers, g.ptr_focus->client) {
            wl_pointer_send_leave(res, ser, g.ptr_focus->resource);
            ptr_send_frame(res);
        }
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
    /* xdg-shell: "An xdg_surface must only be destroyed after its role
     * object has been destroyed, otherwise a defunct_role_object error is
     * raised." Enforcing it keeps the surface's one tracked toplevel the
     * only one that can ever exist -- see xdg_surface_get_toplevel. */
    struct surface *s = wl_resource_get_user_data(r);
    if (s && s->xdg_toplevel) {
        wl_resource_post_error(r, XDG_SURFACE_ERROR_DEFUNCT_ROLE_OBJECT,
                               "xdg_surface destroyed before its xdg_toplevel");
        return;
    }
    wl_resource_destroy(r);
}
/* Clear the surface's back-pointer so a later destroy does not null the
 * user_data of a resource that is already gone. */
static void xdg_surface_resource_destroy(struct wl_resource *r) {
    struct surface *s = wl_resource_get_user_data(r);
    if (s && s->xdg_surface == r) s->xdg_surface = NULL;
}
static void toplevel_resource_destroy(struct wl_resource *r) {
    struct surface *s = wl_resource_get_user_data(r);
    if (!s || s->xdg_toplevel != r) return;
    s->xdg_toplevel = NULL;
    /* xdg_toplevel.destroy "destroys the role surface and unmaps the
     * surface". A surface left mapped here kept compositing its last
     * buffer and kept keyboard focus for a client that believes its window
     * is gone. A new role must go through a new configure handshake. */
    unmap_surface(s);
    s->configured = 0;
}
static void xdg_surface_get_toplevel(struct wl_client *client,
                                     struct wl_resource *resource,
                                     uint32_t id) {
    struct surface *s = wl_resource_get_user_data(resource);
    /* A second role object on the same surface would overwrite
     * s->xdg_toplevel and orphan the first one, which keeps s as its
     * user_data. surface_resource_destroy only clears the TRACKED one, so
     * after wl_surface.destroy the orphan would dangle into freed memory
     * (toplevel_set_app_id writes through it; toplevel_move parks it in
     * g.grab). The protocol already forbids it -- reject it. */
    if (s && s->xdg_toplevel) {
        wl_resource_post_error(resource, XDG_SURFACE_ERROR_ALREADY_CONSTRUCTED,
                               "xdg_surface already has an xdg_toplevel");
        return;
    }
    struct wl_resource *tl = wl_resource_create(
        client, &xdg_toplevel_interface, wl_resource_get_version(resource), id);
    if (!tl) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(tl, &toplevel_impl, s,
                                   toplevel_resource_destroy);
    if (s) { s->xdg_toplevel = tl; send_surface_enter(s); }

    /* Advertise a suggested size of 0x0 ("you decide") plus the initial
     * configure. The window is not mapped until the client acks and
     * commits a buffer. */
    struct wl_array states;
    wl_array_init(&states);
    uint32_t *st = wl_array_add(&states, sizeof(uint32_t));
    if (st) *st = XDG_TOPLEVEL_STATE_ACTIVATED;
    xdg_toplevel_send_configure(tl, 0, 0, &states);
    wl_array_release(&states);
    if (s) {
        s->configured = 0;
        s->pending_serials.size = 0;
        surface_send_xdg_configure(s);
    } else {
        xdg_surface_send_configure(resource, wl_display_next_serial(g.display));
    }
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
                                      uint32_t serial) {
    struct surface *s = wl_resource_get_user_data(r);
    if (!s) return;
    /* Any configure sent for this role and not yet superseded by an acked
     * one may be acked; anything else is the protocol's invalid_serial. An
     * ack retires its serial and every older one. */
    uint32_t *pending = s->pending_serials.data;
    size_t n = s->pending_serials.size / sizeof *pending, k = 0;
    while (k < n && pending[k] != serial) k++;
    if (!s->xdg_toplevel || k == n) {
        wl_resource_post_error(r, XDG_SURFACE_ERROR_INVALID_SERIAL,
                               "ack_configure serial %u was never sent", serial);
        return;
    }
    memmove(pending, pending + k + 1, (n - k - 1) * sizeof *pending);
    s->pending_serials.size = (n - k - 1) * sizeof *pending;
    s->configured = 1;
}
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
/* xdg_positioner. A positioner only carries placement state for
 * xdg_surface.get_popup, which this compositor rejects (no xdg_popup yet), so
 * nothing reads the state. The requests still need real handlers: a resource
 * with a NULL implementation makes libwayland abort the whole server on the
 * first request, so a toolkit building a tooltip (GTK, Qt) killed the desktop
 * instead of only having its popup refused. The spec's input checks stay. */
static void positioner_destroy(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static void positioner_set_size(struct wl_client *c, struct wl_resource *r,
                                int32_t w, int32_t h) {
    if (w <= 0 || h <= 0)
        wl_resource_post_error(r, XDG_POSITIONER_ERROR_INVALID_INPUT,
                               "set_size %dx%d must be positive", w, h);
}
static void positioner_set_anchor_rect(struct wl_client *c,
                                       struct wl_resource *r, int32_t x,
                                       int32_t y, int32_t w, int32_t h) {
    if (w < 0 || h < 0)
        wl_resource_post_error(r, XDG_POSITIONER_ERROR_INVALID_INPUT,
                               "set_anchor_rect %dx%d is negative", w, h);
}
static void positioner_set_anchor(struct wl_client *c, struct wl_resource *r,
                                  uint32_t anchor) {}
static void positioner_set_gravity(struct wl_client *c, struct wl_resource *r,
                                   uint32_t gravity) {}
static void positioner_set_constraint_adjustment(struct wl_client *c,
                                                 struct wl_resource *r,
                                                 uint32_t adjustment) {}
static void positioner_set_offset(struct wl_client *c, struct wl_resource *r,
                                  int32_t x, int32_t y) {}
static void positioner_set_reactive(struct wl_client *c,
                                    struct wl_resource *r) {}
static void positioner_set_parent_size(struct wl_client *c,
                                       struct wl_resource *r, int32_t w,
                                       int32_t h) {}
static void positioner_set_parent_configure(struct wl_client *c,
                                            struct wl_resource *r,
                                            uint32_t serial) {}
static const struct xdg_positioner_interface positioner_impl = {
    .destroy = positioner_destroy,
    .set_size = positioner_set_size,
    .set_anchor_rect = positioner_set_anchor_rect,
    .set_anchor = positioner_set_anchor,
    .set_gravity = positioner_set_gravity,
    .set_constraint_adjustment = positioner_set_constraint_adjustment,
    .set_offset = positioner_set_offset,
    .set_reactive = positioner_set_reactive,
    .set_parent_size = positioner_set_parent_size,
    .set_parent_configure = positioner_set_parent_configure,
};
static void wm_base_create_positioner(struct wl_client *c, struct wl_resource *r,
                                      uint32_t id) {
    struct wl_resource *p = wl_resource_create(
        c, &xdg_positioner_interface, wl_resource_get_version(r), id);
    if (!p) {
        wl_client_post_no_memory(c);
        return;
    }
    wl_resource_set_implementation(p, &positioner_impl, NULL, NULL);
}
static void wm_base_get_xdg_surface(struct wl_client *client,
                                    struct wl_resource *resource, uint32_t id,
                                    struct wl_resource *surface) {
    struct surface *s = wl_resource_get_user_data(surface);
    /* Same orphaning hazard as xdg_surface_get_toplevel: a second
     * xdg_surface would overwrite the tracked s->xdg_surface and leave the
     * first dangling after wl_surface.destroy. "role: given wl_surface has
     * another role" is the protocol's answer. */
    if (s && s->xdg_surface) {
        wl_resource_post_error(resource, XDG_WM_BASE_ERROR_ROLE,
                               "wl_surface already has an xdg_surface");
        return;
    }
    /* "Creating an xdg_surface from a wl_surface which has a buffer
     * attached or committed is a client error." */
    if (s && (s->buffer || s->pending_buffer)) {
        wl_resource_post_error(resource, XDG_WM_BASE_ERROR_INVALID_SURFACE_STATE,
                               "wl_surface already has a buffer");
        return;
    }
    struct wl_resource *xs = wl_resource_create(
        client, &xdg_surface_interface, wl_resource_get_version(resource), id);
    if (!xs) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(xs, &xdg_surface_impl, s,
                                   xdg_surface_resource_destroy);
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
/* zxdg_decoration_manager_v1 — force server-side decorations (PR14e)     */
/* ====================================================================== */

/* Negotiate the decoration mode by layout: a tiled window has no titlebar, so
 * DWINDLE forces SERVER_SIDE (the compositor draws the border/focus ring and
 * the client drops its CSD); FLOATING grants CLIENT_SIDE so a draggable
 * titlebar stays. The client's preferred mode is acknowledged but ignored. */
static void decoration_send_mode(struct wl_resource *r) {
    uint32_t mode = g.layout == LAYOUT_DWINDLE
                        ? ZXDG_TOPLEVEL_DECORATION_V1_MODE_SERVER_SIDE
                        : ZXDG_TOPLEVEL_DECORATION_V1_MODE_CLIENT_SIDE;
    zxdg_toplevel_decoration_v1_send_configure(r, mode);
}
static void decoration_destroy(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static void decoration_set_mode(struct wl_client *c, struct wl_resource *r,
                                uint32_t mode) {
    decoration_send_mode(r);
}
static void decoration_unset_mode(struct wl_client *c, struct wl_resource *r) {
    decoration_send_mode(r);
}
static const struct zxdg_toplevel_decoration_v1_interface decoration_impl = {
    .destroy = decoration_destroy,
    .set_mode = decoration_set_mode,
    .unset_mode = decoration_unset_mode,
};

static void decoration_mgr_destroy(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static void decoration_mgr_get_toplevel_decoration(
        struct wl_client *client, struct wl_resource *resource, uint32_t id,
        struct wl_resource *toplevel) {
    struct wl_resource *d = wl_resource_create(
        client, &zxdg_toplevel_decoration_v1_interface,
        wl_resource_get_version(resource), id);
    if (!d) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(d, &decoration_impl, NULL, NULL);
    decoration_send_mode(d);   /* initial configure */
}
static const struct zxdg_decoration_manager_v1_interface decoration_mgr_impl = {
    .destroy = decoration_mgr_destroy,
    .get_toplevel_decoration = decoration_mgr_get_toplevel_decoration,
};
static void decoration_mgr_bind(struct wl_client *client, void *data,
                                uint32_t version, uint32_t id) {
    struct wl_resource *r = wl_resource_create(
        client, &zxdg_decoration_manager_v1_interface, version, id);
    if (!r) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(r, &decoration_mgr_impl, NULL, NULL);
}

/* ====================================================================== */
/* zwlr_layer_shell_v1 — the shell-component protocol (PR15)              */
/* ====================================================================== */

/* This is the protocol every desktop shell piece speaks: our kbar and
 * klauncher, and upstream Waybar / mako when they land. State set through the
 * requests below is applied on the next wl_surface.commit, matching the
 * protocol's double-buffering rule: the ones that move the box mark the
 * surface dirty and that commit re-runs layers_arrange. Every commit, not only
 * the first — a client renegotiates its size whenever its content changes. */

static void layer_surface_set_size(struct wl_client *c, struct wl_resource *r,
                                   uint32_t w, uint32_t h) {
    struct surface *s = wl_resource_get_user_data(r);
    s->req_w = (int32_t)w;
    s->req_h = (int32_t)h;
    s->layer_dirty = 1;
}
static void layer_surface_set_anchor(struct wl_client *c, struct wl_resource *r,
                                     uint32_t anchor) {
    struct surface *s = wl_resource_get_user_data(r);
    s->anchor = anchor;
    s->layer_dirty = 1;
}
static void layer_surface_set_exclusive_zone(struct wl_client *c,
                                             struct wl_resource *r,
                                             int32_t zone) {
    struct surface *s = wl_resource_get_user_data(r);
    s->exclusive_zone = zone;
    s->layer_dirty = 1;
}
static void layer_surface_set_margin(struct wl_client *c, struct wl_resource *r,
                                     int32_t top, int32_t right,
                                     int32_t bottom, int32_t left) {
    struct surface *s = wl_resource_get_user_data(r);
    s->margin_top = top;
    s->margin_right = right;
    s->margin_bottom = bottom;
    s->margin_left = left;
    s->layer_dirty = 1;
}
static void layer_surface_set_keyboard_interactivity(struct wl_client *c,
                                                     struct wl_resource *r,
                                                     uint32_t interactivity) {
    struct surface *s = wl_resource_get_user_data(r);
    s->kb_interactive = interactivity;
}
/* Popups need xdg_popup, which the compositor does not implement yet (PR16). */
static void layer_surface_get_popup(struct wl_client *c, struct wl_resource *r,
                                    struct wl_resource *popup) {}
static void layer_surface_ack_configure(struct wl_client *c,
                                        struct wl_resource *r,
                                        uint32_t serial) {}
static void layer_surface_destroy(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static void layer_surface_set_layer(struct wl_client *c, struct wl_resource *r,
                                    uint32_t layer) {
    struct surface *s = wl_resource_get_user_data(r);
    s->layer = layer;
    s->layer_dirty = 1;
}
static const struct zwlr_layer_surface_v1_interface layer_surface_impl = {
    .set_size = layer_surface_set_size,
    .set_anchor = layer_surface_set_anchor,
    .set_exclusive_zone = layer_surface_set_exclusive_zone,
    .set_margin = layer_surface_set_margin,
    .set_keyboard_interactivity = layer_surface_set_keyboard_interactivity,
    .get_popup = layer_surface_get_popup,
    .ack_configure = layer_surface_ack_configure,
    .destroy = layer_surface_destroy,
    .set_layer = layer_surface_set_layer,
};

/* The wl_surface keeps its own resource; dropping the layer role unmaps it
 * and hands the reserved strip back to the windows. */
static void layer_surface_resource_destroy(struct wl_resource *r) {
    struct surface *s = wl_resource_get_user_data(r);
    if (!s) return;
    s->layer_surface = NULL;
    s->mapped = 0;
    layer_remove(s);
    if (g.kbd_focus == s) {
        g.kbd_focus = NULL;
        struct surface *grab = layer_kb_grab();
        kbd_set_focus(grab ? grab : topmost_on_ws(g.active_ws));
    }
    if (g.ptr_focus == s) g.ptr_focus = NULL;
    s->n_frame_cbs = 0;
    layers_arrange();
}

static void layer_shell_get_layer_surface(struct wl_client *client,
                                          struct wl_resource *resource,
                                          uint32_t id,
                                          struct wl_resource *surface,
                                          struct wl_resource *output,
                                          uint32_t layer,
                                          const char *ns) {
    struct surface *s = wl_resource_get_user_data(surface);
    if (layer > ZWLR_LAYER_SHELL_V1_LAYER_OVERLAY) {
        wl_resource_post_error(resource, ZWLR_LAYER_SHELL_V1_ERROR_INVALID_LAYER,
                               "invalid layer %u", layer);
        return;
    }
    struct wl_resource *r = wl_resource_create(
        client, &zwlr_layer_surface_v1_interface,
        wl_resource_get_version(resource), id);
    if (!r) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(r, &layer_surface_impl, s,
                                   layer_surface_resource_destroy);
    s->layer_surface = r;
    s->layer = layer;
    /* Joins the arrangement now, not at map time: the client's first commit
     * carries no buffer and exists only to fetch the configure that tells it
     * what size to render, so it must already be in the list. */
    layer_add(s);
    /* The namespace names the component ("bar", "launcher"); reuse app_id so
     * kwlctl output and the LAYER marker identify it like any other client. */
    snprintf(s->app_id, sizeof(s->app_id), "%s", ns ? ns : "layer");
}

static void layer_shell_destroy(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static const struct zwlr_layer_shell_v1_interface layer_shell_impl = {
    .get_layer_surface = layer_shell_get_layer_surface,
    .destroy = layer_shell_destroy,
};
static void layer_shell_bind(struct wl_client *client, void *data,
                             uint32_t version, uint32_t id) {
    struct wl_resource *r = wl_resource_create(
        client, &zwlr_layer_shell_v1_interface, version, id);
    if (!r) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(r, &layer_shell_impl, NULL, NULL);
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
    wl_list_remove(wl_resource_get_link(r));
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
    wl_list_remove(wl_resource_get_link(r));
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
        for_each_seat_res(res, &g.keyboards, g.kbd_focus->client)
            wl_keyboard_send_leave(res, serial, g.kbd_focus->resource);
    }
    g.kbd_focus = s;
    /* Nothing focused, or a shell component took the keyboard: either way no
     * window is active, and the bar clears its title. */
    if (!s || s->layer_surface || s->lock_surface) {
        kwlctl_emit("activewindow>>,");
        kwlctl_emit("activewindowv2>>");
    }
    if (!s) return;
    /* wl_data_device: "the selection is sent to a client immediately before
     * receiving keyboard focus", so a paste on its first key sees it. */
    selection_send_to_client(s->client);
    struct wl_array keys;
    wl_array_init(&keys);
    for_each_seat_res(res, &g.keyboards, s->client) {
        wl_keyboard_send_enter(res, serial, s->resource, &keys);
        send_modifiers_to(res, serial);
    }
    wl_array_release(&keys);
    schedule_repaint();   /* focus border moved */
    if (s->layer_surface || s->lock_surface) return;
    kwlctl_emit("activewindow>>%s,%s", s->app_id, s->title);
    kwlctl_emit("activewindowv2>>%p", (void *)s);
    /* Observable focus marker: keyboard focus only moves to a window once its
     * first commit maps it (surface_commit), so this is the authoritative
     * "the window is now closeable by killactive" signal — distinct from a
     * client's own READY print, which fires when it *queues* its first commit,
     * before the compositor has processed the map and moved focus here. */
    printf("KBD_FOCUS app_id=%s\n", s->app_id);
    fflush(stdout);
}

/* Pointer focus follows the surface under the cursor. */
static void ptr_set_focus(struct surface *s) {
    if (g.ptr_focus == s) return;
    uint32_t serial = wl_display_next_serial(g.display);
    if (g.ptr_focus) {
        for_each_seat_res(res, &g.pointers, g.ptr_focus->client) {
            wl_pointer_send_leave(res, serial, g.ptr_focus->resource);
            ptr_send_frame(res);
        }
    }
    g.ptr_focus = s;
    if (!s) return;
    wl_fixed_t lx = wl_fixed_from_double(g.cursor_x - s->x);
    wl_fixed_t ly = wl_fixed_from_double(g.cursor_y - s->y);
    for_each_seat_res(res, &g.pointers, s->client) {
        wl_pointer_send_enter(res, serial, s->resource, lx, ly);
        ptr_send_frame(res);
    }
}

static void ptr_refresh_focus(void) {
    if (g.grab) return;   /* no pointer focus during a move grab */
    ptr_set_focus(surface_at(g.cursor_x, g.cursor_y));
}

/* ---- workspaces --------------------------------------------------------- */

/* Hyprland's protocol has explicit workspace lifetime events; ours exist
 * implicitly (occupied or active). Diff the derived set against the last
 * broadcast one and emit create/destroy for the delta. */
static void workspaces_sync(void) {
    static uint32_t known;
    uint32_t mask = 1u << g.active_ws;
    for (int i = 0; i < g.n_surfaces; i++)
        if (g.zorder[i]->mapped && g.zorder[i]->workspace)
            mask |= 1u << g.zorder[i]->workspace;
    for (int ws = 1; ws <= N_WORKSPACES; ws++) {
        uint32_t bit = 1u << ws;
        if ((mask & bit) && !(known & bit)) {
            kwlctl_emit("createworkspace>>%d", ws);
            kwlctl_emit("createworkspacev2>>%d,%d", ws, ws);
        } else if (!(mask & bit) && (known & bit)) {
            kwlctl_emit("destroyworkspace>>%d", ws);
            kwlctl_emit("destroyworkspacev2>>%d,%d", ws, ws);
        }
    }
    known = mask;
}

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
    kwlctl_emit("workspacev2>>%d,%d", ws, ws);
    kwlctl_emit("focusedmon>>virtual-0,%d", ws);
    kwlctl_emit("focusedmonv2>>virtual-0,%d", ws);
    workspaces_sync();
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
    kwlctl_emit("movewindow>>%p,%d", (void *)s, ws);
    kwlctl_emit("movewindowv2>>%p,%d,%d", (void *)s, ws, ws);
    workspaces_sync();
}

static void seat_get_pointer(struct wl_client *client,
                             struct wl_resource *resource, uint32_t id) {
    struct wl_resource *p = wl_resource_create(
        client, &wl_pointer_interface, wl_resource_get_version(resource), id);
    if (!p) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(p, &pointer_impl, NULL,
                                   pointer_resource_destroy);
    wl_list_insert(&g.pointers, wl_resource_get_link(p));
    /* If this client's surface already holds pointer focus, enter it now. */
    if (g.ptr_focus && g.ptr_focus->client == client && g.ptr_focus->mapped) {
        wl_pointer_send_enter(p, wl_display_next_serial(g.display),
                              g.ptr_focus->resource,
                              wl_fixed_from_double(g.cursor_x - g.ptr_focus->x),
                              wl_fixed_from_double(g.cursor_y - g.ptr_focus->y));
        ptr_send_frame(p);
    }
}
static void seat_get_keyboard(struct wl_client *client,
                              struct wl_resource *resource, uint32_t id) {
    struct wl_resource *k = wl_resource_create(
        client, &wl_keyboard_interface, wl_resource_get_version(resource), id);
    if (!k) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(k, &keyboard_impl, NULL,
                                   keyboard_resource_destroy);
    wl_list_insert(&g.keyboards, wl_resource_get_link(k));
    send_keymap(k);
    if (wl_resource_get_version(k) >= WL_KEYBOARD_REPEAT_INFO_SINCE_VERSION)
        wl_keyboard_send_repeat_info(k, 25, 400);
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
        wl_resource_create(client, &wl_seat_interface, (int)version, id);
    if (!r) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(r, &seat_impl, NULL, NULL);
    wl_seat_send_capabilities(
        r, WL_SEAT_CAPABILITY_KEYBOARD | WL_SEAT_CAPABILITY_POINTER);
    if (version >= WL_SEAT_NAME_SINCE_VERSION)
        wl_seat_send_name(r, "seat0");
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
static void output_resource_destroy(struct wl_resource *r) {
    wl_list_remove(wl_resource_get_link(r));
}
static void output_bind(struct wl_client *client, void *data, uint32_t version,
                        uint32_t id) {
    struct wl_resource *r =
        wl_resource_create(client, &wl_output_interface, version, id);
    if (!r) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(r, &output_impl, NULL,
                                   output_resource_destroy);
    wl_list_insert(&g.outputs, wl_resource_get_link(r));
    /* The physical size is the connector's, which the host reports for the
     * display the pane occupies. 0x0 means unknown (a host with no display);
     * never substitute pixels, which a DPI-aware client would read as a
     * 25.4 dpi screen. */
    wl_output_send_geometry(r, 0, 0, g.mm_width, g.mm_height,
                            WL_OUTPUT_SUBPIXEL_UNKNOWN, "Kandelo", "virtual-0",
                            WL_OUTPUT_TRANSFORM_NORMAL);
    /* wl_output.mode is in device pixels; wl_output.scale is how a client
     * turns it into the logical grid xdg_output reports. */
    wl_output_send_mode(r,
                        WL_OUTPUT_MODE_CURRENT | WL_OUTPUT_MODE_PREFERRED,
                        (int32_t)g.pw, (int32_t)g.ph, 60000);
    if (version >= WL_OUTPUT_SCALE_SINCE_VERSION)
        wl_output_send_scale(r, (int32_t)g.scale);
    /* v4: the name a client keys config on (mako binds v4 uncondition-
     * ally); matches the xdg_output name. */
    if (version >= WL_OUTPUT_NAME_SINCE_VERSION)
        wl_output_send_name(r, "virtual-0");
    if (version >= WL_OUTPUT_DESCRIPTION_SINCE_VERSION)
        wl_output_send_description(r, "Kandelo virtual output");
    if (version >= WL_OUTPUT_DONE_SINCE_VERSION)
        wl_output_send_done(r);
}

/* Tell a surface which output it is on. A DPI-aware client reads the output's
 * scale from it: foot defers font sizing until it arrives, and mako picks the
 * scale of its next buffer from it. So a role sends it as soon as the surface
 * takes one — the desktop has a single output, and a surface with a role is on
 * it. Waiting for the map is one frame too late: the buffer being mapped was
 * already drawn at the wrong scale. Map sends it too, for a client that binds
 * wl_output only after its surface has a role. */
static void send_surface_enter(struct surface *s) {
    if (s->entered) return;
    for_each_seat_res(res, &g.outputs, s->client) {
        wl_surface_send_enter(s->resource, res);
        s->entered = 1;
    }
}

/* ====================================================================== */
/* zxdg_output_manager_v1: logical output geometry                        */
/* ====================================================================== */

/* The single virtual output is fullscreen at (0,0), so the logical grid is
 * the mode divided by the output scale — g.width/g.height. The geometry is
 * fixed for the process lifetime, so each xdg_output is a one-shot burst
 * with no tracking list. */
static void xdg_output_destroy_req(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static const struct zxdg_output_v1_interface xdg_output_impl = {
    .destroy = xdg_output_destroy_req,
};
static void xdg_output_mgr_destroy(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static void xdg_output_mgr_get(struct wl_client *c, struct wl_resource *r,
                               uint32_t id, struct wl_resource *output) {
    struct wl_resource *xo = wl_resource_create(
        c, &zxdg_output_v1_interface, wl_resource_get_version(r), id);
    if (!xo) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(xo, &xdg_output_impl, NULL, NULL);
    zxdg_output_v1_send_logical_position(xo, 0, 0);
    zxdg_output_v1_send_logical_size(xo, (int32_t)g.width, (int32_t)g.height);
    if (wl_resource_get_version(xo) >= ZXDG_OUTPUT_V1_NAME_SINCE_VERSION)
        zxdg_output_v1_send_name(xo, "virtual-0");
    if (wl_resource_get_version(xo) >= ZXDG_OUTPUT_V1_DESCRIPTION_SINCE_VERSION)
        zxdg_output_v1_send_description(xo, "Kandelo virtual output");
    /* v3 deprecates xdg_output.done in favor of wl_output.done; a v1/v2
     * bind still expects it here. */
    if (wl_resource_get_version(xo) < 3)
        zxdg_output_v1_send_done(xo);
    else if (wl_resource_get_version(output) >= WL_OUTPUT_DONE_SINCE_VERSION)
        wl_output_send_done(output);
}
static const struct zxdg_output_manager_v1_interface xdg_output_mgr_impl = {
    .destroy = xdg_output_mgr_destroy,
    .get_xdg_output = xdg_output_mgr_get,
};
static void xdg_output_mgr_bind(struct wl_client *c, void *data, uint32_t ver,
                                uint32_t id) {
    struct wl_resource *r = wl_resource_create(
        c, &zxdg_output_manager_v1_interface, (int)ver, id);
    if (!r) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(r, &xdg_output_mgr_impl, NULL, NULL);
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
    if (drmModeAddFB2(g.card_fd, g.pw, g.ph, DRM_FORMAT_XRGB8888,
                      handles, pitches, offsets, &fb_id, 0) < 0) {
        perror("drmModeAddFB2");
        return 0;
    }
    gbm_bo_set_user_data(bo, (void *)(uintptr_t)fb_id, bo_fb_destroy);
    return fb_id;
}

/* Does this buffer's format carry a meaningful alpha channel? The wl_shm and
 * linux-dmabuf paths store their own format enums in the same field, so both
 * ARGB constants are checked, plus dmabuf's ABGR. They cannot collide:
 * WL_SHM_FORMAT_ARGB8888 is 0 and the DRM constants are fourcc codes. */
static inline int buffer_has_alpha(const struct shm_buffer *b) {
    return b->format == WL_SHM_FORMAT_ARGB8888 ||
           b->format == DRM_FORMAT_ARGB8888 ||
           b->format == DRM_FORMAT_ABGR8888;
}

/* Does this buffer store its pixels red-first? DRM XRGB/ARGB8888 is
 * little-endian [B,G,R,X/A] in memory; XBGR/ABGR8888 is [R,G,B,X/A], the
 * byte order of a GL RGBA texture, which is what a GL client's GPU-tier bo
 * holds. Only linux-dmabuf accepts the BGR pair. */
static inline int buffer_is_bgr_format(const struct shm_buffer *b) {
    return b->format == DRM_FORMAT_XBGR8888 ||
           b->format == DRM_FORMAT_ABGR8888;
}

/* One XBGR/ABGR pixel as the XRGB/ARGB word the scanout holds. */
static inline uint32_t swap_red_blue(uint32_t px) {
    return (px & 0xff00ff00u) | ((px & 0xffu) << 16) | ((px >> 16) & 0xffu);
}

/* Fragment-shader texture modes (u_use_tex). An alpha buffer (ARGB/ABGR)
 * keeps its sampled alpha and composites source-over; an opaque one forces
 * alpha to 1 because its fourth channel carries no coverage. A BGR-format
 * buffer (XBGR/ABGR) is read without the red/blue swizzle. */
enum {
    GLC_TEX_OPAQUE = 1,
    GLC_TEX_ALPHA = 2,
    GLC_TEX_OPAQUE_RGBA_ORDER = 3,
    GLC_TEX_ALPHA_RGBA_ORDER = 4,
};

static int glc_tex_mode(const struct shm_buffer *b) {
    int alpha = buffer_has_alpha(b);
    if (buffer_is_bgr_format(b))
        return alpha ? GLC_TEX_ALPHA_RGBA_ORDER : GLC_TEX_OPAQUE_RGBA_ORDER;
    return alpha ? GLC_TEX_ALPHA : GLC_TEX_OPAQUE;
}

/* The texture mode for a surface's current buffer (a layer surface's
 * texture is drawn source-over when it carries alpha). */
static int layer_tex_mode(const struct surface *s) {
    struct shm_buffer *b = s->buffer ? wl_resource_get_user_data(s->buffer) : NULL;
    return b ? glc_tex_mode(b) : GLC_TEX_OPAQUE;
}

/* Source-over composite of one premultiplied ARGB pixel onto an opaque
 * destination. wl_shm ARGB8888 is premultiplied by the Wayland spec, so the
 * source contributes unscaled and the destination is attenuated by 1 - alpha. */
static inline uint32_t blend_premultiplied(uint32_t src, uint32_t dst) {
    uint32_t inv = 255u - (src >> 24);
    uint32_t rb = ((((dst & 0x00ff00ffu) * inv) >> 8) & 0x00ff00ffu);
    uint32_t g = ((((dst & 0x0000ff00u) * inv) >> 8) & 0x0000ff00u);
    return src + rb + g;
}

/* Copy one committed wl_shm buffer into the scanout bo at the surface's
 * position, clipped to the output. The surface box is logical and the
 * scanout is device pixels, so the destination is the box times the output
 * scale. An XRGB8888 buffer overwrites; an ARGB8888 one composites
 * source-over so a client's transparent regions show what is behind them
 * instead of punching the surface's background through as black.
 * A client whose buffer already covers that destination — it honoured
 * set_buffer_scale — takes the memcpy path; anything else (a scale-1
 * client on a scaled output, or a wp_viewport surface) nearest-samples its
 * source rect across the destination box. */
static void blit_surface(struct surface *s, uint32_t *dst, uint32_t dst_stride_px) {
    if (!s->buffer) return;
    struct shm_buffer *b = wl_resource_get_user_data(s->buffer);
    if (!b) return;
    uint32_t src_stride_px = 0;
    uint32_t *src = shm_buffer_pixels(b, &src_stride_px);
    if (!src) return;

    int32_t lw, lh;
    surface_committed_size(s, b, &lw, &lh);
    /* Every size below is client input (buffer, viewport, committed size)
     * times the output scale. Compute in 64-bit, and walk only the part of
     * the destination box that lies on the output: iterating the whole box
     * let one very large (but protocol-valid) buffer cost the
     * single-threaded compositor hundreds of millions of iterations per
     * repaint, and s->x * scale + width could overflow int32. */
    const int64_t scale = (int64_t)g.scale;
    const int64_t ox = (int64_t)s->x * scale, oy = (int64_t)s->y * scale;
    const int64_t dw = (int64_t)lw * scale, dh = (int64_t)lh * scale;
    if (dw <= 0 || dh <= 0) return;
    const int64_t PW = (int64_t)g.pw, PH = (int64_t)g.ph;
    int alpha = buffer_has_alpha(b);
    int bgr = buffer_is_bgr_format(b);

    if (s->vp_src_w > 0 || dw != b->width || dh != b->height) {
        double sx0 = 0.0, sy0 = 0.0;
        double sw = (double)b->width, sh = (double)b->height;
        if (s->vp_src_w > 0) {
            sx0 = wl_fixed_to_double(s->vp_src_x);
            sy0 = wl_fixed_to_double(s->vp_src_y);
            sw = wl_fixed_to_double(s->vp_src_w);
            sh = wl_fixed_to_double(s->vp_src_h);
        }
        int64_t r0 = oy < 0 ? -oy : 0, r1 = PH - oy < dh ? PH - oy : dh;
        int64_t c0 = ox < 0 ? -ox : 0, c1 = PW - ox < dw ? PW - ox : dw;
        for (int64_t row = r0; row < r1; row++) {
            int64_t sy = (int64_t)(sy0 + ((double)row + 0.5) * sh / (double)dh);
            if (sy < 0) sy = 0;
            if (sy >= b->height) sy = b->height - 1;
            for (int64_t col = c0; col < c1; col++) {
                int64_t sx = (int64_t)(sx0 + ((double)col + 0.5) * sw / (double)dw);
                if (sx < 0) sx = 0;
                if (sx >= b->width) sx = b->width - 1;
                uint32_t px = src[(size_t)sy * src_stride_px + (size_t)sx];
                if (bgr) px = swap_red_blue(px);
                uint32_t *slot = &dst[(size_t)(oy + row) * dst_stride_px + (size_t)(ox + col)];
                *slot = alpha ? blend_premultiplied(px, *slot) : px;
            }
        }
        return;
    }

    /* The buffer covers the destination 1:1: copy only its intersection
     * with the output. */
    int64_t x0 = ox < 0 ? -ox : 0;
    int64_t x1 = PW - ox;
    if (x1 > b->width) x1 = b->width;
    int64_t y0 = oy < 0 ? -oy : 0;
    int64_t y1 = PH - oy;
    if (y1 > b->height) y1 = b->height;
    if (x1 <= x0 || y1 <= y0) return;
    for (int64_t row = y0; row < y1; row++) {
        uint32_t *drow = dst + (size_t)(oy + row) * dst_stride_px + (size_t)(ox + x0);
        const uint32_t *srow = src + (size_t)row * src_stride_px + (size_t)x0;
        if (!alpha && !bgr) {
            memcpy(drow, srow, (size_t)(x1 - x0) * 4);
            continue;
        }
        for (int64_t col = 0; col < x1 - x0; col++) {
            uint32_t px = bgr ? swap_red_blue(srow[col]) : srow[col];
            drow[col] = alpha ? blend_premultiplied(px, drow[col]) : px;
        }
    }
}

/* Subsurfaces ride their parent: recompute their output position from the
 * parent's (tiling moves the parent under them) and blit right above it. */
static void blit_subsurfaces(struct surface *s, uint32_t *dst,
                             uint32_t dst_stride_px) {
    for (int i = 0; i < g.n_all_surfaces; i++) {
        struct surface *c = g.all_surfaces[i];
        if (c->parent != s || !surface_visible(c) || !c->buffer) continue;
        c->x = s->x + c->sub_x;
        c->y = s->y + c->sub_y;
        blit_surface(c, dst, dst_stride_px);
    }
}

/* A 2px accent border around the keyboard-focused window, so the active
 * window is visible even though decoration is client-side. */
static void draw_focus_border(struct surface *s, uint32_t *dst,
                              uint32_t stride_px) {
    const uint32_t color = th.border_active;
    const int64_t scale = (int64_t)g.scale;
    const int64_t W = g.pw, H = g.ph;
    const int64_t bx = (int64_t)s->x * scale, by = (int64_t)s->y * scale;
    const int64_t bw = (int64_t)s->w * scale, bh = (int64_t)s->h * scale;
    for (int64_t e = 1; e <= 2 * scale; e++) {
        /* Edges in 64-bit (client-sized w/h), each loop clamped to the
         * output so its cost is bounded by the screen, not the window. */
        int64_t x0 = bx - e, y0 = by - e;
        int64_t x1 = bx + bw + e - 1, y1 = by + bh + e - 1;
        int64_t xa = x0 < 0 ? 0 : x0, xb = x1 >= W ? W - 1 : x1;
        int64_t ya = y0 < 0 ? 0 : y0, yb = y1 >= H ? H - 1 : y1;
        for (int64_t x = xa; x <= xb; x++) {
            if (y0 >= 0 && y0 < H) dst[(size_t)y0 * stride_px + (size_t)x] = color;
            if (y1 >= 0 && y1 < H) dst[(size_t)y1 * stride_px + (size_t)x] = color;
        }
        for (int64_t y = ya; y <= yb; y++) {
            if (x0 >= 0 && x0 < W) dst[(size_t)y * stride_px + (size_t)x0] = color;
            if (x1 >= 0 && x1 < W) dst[(size_t)y * stride_px + (size_t)x1] = color;
        }
    }
}

/* Layer surfaces composite outside the window z-order: background/bottom under
 * every window, top/overlay over them. Both compositing paths walk the layer
 * list twice through this predicate. */
static int layer_in_band(const struct surface *s, int above) {
    if (!surface_visible(s)) return 0;
    int over = s->layer >= ZWLR_LAYER_SHELL_V1_LAYER_TOP;
    return above ? over : !over;
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
    for (int i = 0; i < g.n_layers; i++)
        send_frame_callbacks(g.layers[i]);
    if (lk.surface) send_frame_callbacks(lk.surface);
}

/* ====================================================================== */
/* wp_presentation: flip-timestamp feedback                               */
/* ====================================================================== */

/* Feedback for a visible surface reports the flip that showed it; feedback
 * for a hidden one (other workspace, unmapped) is discarded at the same
 * flip. sec/nsec are CLOCK_MONOTONIC — the clock kernel_vblank stamps
 * page-flip events with, matching the advertised clock_id. */
static void send_presentation_feedback(struct surface *s, uint32_t sec,
                                       uint32_t nsec, uint32_t seq) {
    uint32_t refresh_ns =
        g.mode.vrefresh ? 1000000000u / g.mode.vrefresh : 0;
    int visible = surface_visible(s);
    while (s->n_feedbacks > 0) {
        struct wl_resource *fb = s->feedbacks[--s->n_feedbacks];
        wl_resource_set_user_data(fb, NULL);
        if (visible)
            wp_presentation_feedback_send_presented(
                fb, 0, sec, nsec, refresh_ns, 0, seq,
                WP_PRESENTATION_FEEDBACK_KIND_VSYNC);
        else
            wp_presentation_feedback_send_discarded(fb);
        wl_resource_destroy(fb);
    }
}
static void send_all_presentation_feedback(uint32_t sec, uint32_t nsec,
                                           uint32_t seq) {
    for (int i = 0; i < g.n_surfaces; i++)
        send_presentation_feedback(g.zorder[i], sec, nsec, seq);
    for (int i = 0; i < g.n_layers; i++)
        send_presentation_feedback(g.layers[i], sec, nsec, seq);
    if (lk.surface) send_presentation_feedback(lk.surface, sec, nsec, seq);
}

static void presentation_destroy(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static void feedback_resource_destroy(struct wl_resource *r) {
    struct surface *s = wl_resource_get_user_data(r);
    if (!s) return;
    for (int i = 0; i < s->n_feedbacks; i++) {
        if (s->feedbacks[i] != r) continue;
        s->feedbacks[i] = s->feedbacks[--s->n_feedbacks];
        break;
    }
}
static void presentation_feedback(struct wl_client *c, struct wl_resource *r,
                                  struct wl_resource *surface, uint32_t id) {
    struct surface *s = wl_resource_get_user_data(surface);
    struct wl_resource *fb =
        wl_resource_create(c, &wp_presentation_feedback_interface, 1, id);
    if (!fb) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(fb, NULL, s, feedback_resource_destroy);
    if (s->n_feedbacks < MAX_FRAME_CB) {
        s->feedbacks[s->n_feedbacks++] = fb;
        return;
    }
    wp_presentation_feedback_send_discarded(fb);
    wl_resource_destroy(fb);
}
static const struct wp_presentation_interface presentation_impl = {
    .destroy = presentation_destroy,
    .feedback = presentation_feedback,
};
static void presentation_bind(struct wl_client *c, void *data, uint32_t ver,
                              uint32_t id) {
    struct wl_resource *r =
        wl_resource_create(c, &wp_presentation_interface, (int)ver, id);
    if (!r) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(r, &presentation_impl, NULL, NULL);
    wp_presentation_send_clock_id(r, CLOCK_MONOTONIC);
}

/* ====================================================================== */
/* wl_subcompositor: parent-glued overlay subsurfaces                     */
/* ====================================================================== */

static void subsurface_destroy(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static void subsurface_set_position(struct wl_client *c, struct wl_resource *r,
                                    int32_t x, int32_t y) {
    struct surface *s = wl_resource_get_user_data(r);
    if (!s) return;
    s->sub_x = x;
    s->sub_y = y;
    schedule_repaint();
}
static void subsurface_place_above(struct wl_client *c, struct wl_resource *r,
                                   struct wl_resource *sibling) {}
static void subsurface_place_below(struct wl_client *c, struct wl_resource *r,
                                   struct wl_resource *sibling) {}
static void subsurface_set_sync(struct wl_client *c, struct wl_resource *r) {}
static void subsurface_set_desync(struct wl_client *c, struct wl_resource *r) {}
static const struct wl_subsurface_interface subsurface_impl = {
    .destroy = subsurface_destroy,
    .set_position = subsurface_set_position,
    .place_above = subsurface_place_above,
    .place_below = subsurface_place_below,
    .set_sync = subsurface_set_sync,
    .set_desync = subsurface_set_desync,
};
static void subsurface_resource_destroy(struct wl_resource *r) {
    struct surface *s = wl_resource_get_user_data(r);
    if (!s) return;
    s->subsurface = NULL;
    s->parent = NULL;
    s->mapped = 0;
    schedule_repaint();
}

static void subcompositor_destroy(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static void subcompositor_get_subsurface(struct wl_client *c,
                                         struct wl_resource *r, uint32_t id,
                                         struct wl_resource *surface,
                                         struct wl_resource *parent) {
    struct surface *s = wl_resource_get_user_data(surface);
    struct surface *p = wl_resource_get_user_data(parent);
    struct wl_resource *sub =
        wl_resource_create(c, &wl_subsurface_interface, 1, id);
    if (!sub) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(sub, &subsurface_impl, s,
                                   subsurface_resource_destroy);
    s->subsurface = sub;
    s->parent = p;
}
static const struct wl_subcompositor_interface subcompositor_impl = {
    .destroy = subcompositor_destroy,
    .get_subsurface = subcompositor_get_subsurface,
};
static void subcompositor_bind(struct wl_client *c, void *data, uint32_t ver,
                               uint32_t id) {
    struct wl_resource *r =
        wl_resource_create(c, &wl_subcompositor_interface, (int)ver, id);
    if (!r) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(r, &subcompositor_impl, NULL, NULL);
}

/* ====================================================================== */
/* wp_viewporter: per-surface crop + scale                                */
/* ====================================================================== */

static void viewport_destroy_req(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static void viewport_set_source(struct wl_client *c, struct wl_resource *r,
                                wl_fixed_t x, wl_fixed_t y, wl_fixed_t w,
                                wl_fixed_t h) {
    struct surface *s = wl_resource_get_user_data(r);
    if (!s) {
        wl_resource_post_error(r, WP_VIEWPORT_ERROR_NO_SURFACE,
                               "the wl_surface was destroyed");
        return;
    }
    int unset = x == wl_fixed_from_int(-1) && y == wl_fixed_from_int(-1) &&
                w == wl_fixed_from_int(-1) && h == wl_fixed_from_int(-1);
    if (!unset && (x < 0 || y < 0 || w <= 0 || h <= 0)) {
        wl_resource_post_error(r, WP_VIEWPORT_ERROR_BAD_VALUE,
                               "invalid source rectangle");
        return;
    }
    s->vp_src_x = unset ? 0 : x;
    s->vp_src_y = unset ? 0 : y;
    s->vp_src_w = unset ? 0 : w;
    s->vp_src_h = unset ? 0 : h;
    schedule_repaint();
}
static void viewport_set_destination(struct wl_client *c, struct wl_resource *r,
                                     int32_t w, int32_t h) {
    struct surface *s = wl_resource_get_user_data(r);
    if (!s) {
        wl_resource_post_error(r, WP_VIEWPORT_ERROR_NO_SURFACE,
                               "the wl_surface was destroyed");
        return;
    }
    int unset = w == -1 && h == -1;
    if (!unset && (w <= 0 || h <= 0)) {
        wl_resource_post_error(r, WP_VIEWPORT_ERROR_BAD_VALUE,
                               "invalid destination size");
        return;
    }
    s->vp_dst_w = unset ? 0 : w;
    s->vp_dst_h = unset ? 0 : h;
    schedule_repaint();
}
static const struct wp_viewport_interface viewport_impl = {
    .destroy = viewport_destroy_req,
    .set_source = viewport_set_source,
    .set_destination = viewport_set_destination,
};
static void viewport_resource_destroy(struct wl_resource *r) {
    struct surface *s = wl_resource_get_user_data(r);
    if (!s) return;
    s->viewport = NULL;
    s->vp_src_x = s->vp_src_y = s->vp_src_w = s->vp_src_h = 0;
    s->vp_dst_w = s->vp_dst_h = 0;
    schedule_repaint();
}

static void viewporter_destroy(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static void viewporter_get_viewport(struct wl_client *c, struct wl_resource *r,
                                    uint32_t id, struct wl_resource *surface) {
    struct surface *s = wl_resource_get_user_data(surface);
    if (s->viewport) {
        wl_resource_post_error(r, WP_VIEWPORTER_ERROR_VIEWPORT_EXISTS,
                               "the surface already has a viewport");
        return;
    }
    struct wl_resource *vp =
        wl_resource_create(c, &wp_viewport_interface, 1, id);
    if (!vp) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(vp, &viewport_impl, s,
                                   viewport_resource_destroy);
    s->viewport = vp;
}
static const struct wp_viewporter_interface viewporter_impl = {
    .destroy = viewporter_destroy,
    .get_viewport = viewporter_get_viewport,
};
static void viewporter_bind(struct wl_client *c, void *data, uint32_t ver,
                            uint32_t id) {
    struct wl_resource *r =
        wl_resource_create(c, &wp_viewporter_interface, (int)ver, id);
    if (!r) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(r, &viewporter_impl, NULL, NULL);
}

/* ====================================================================== */
/* wp_fractional_scale_manager_v1: fixed scale-1 preference               */
/* ====================================================================== */

static void fractional_scale_destroy_req(struct wl_client *c,
                                         struct wl_resource *r) {
    wl_resource_destroy(r);
}
static const struct wp_fractional_scale_v1_interface fractional_scale_impl = {
    .destroy = fractional_scale_destroy_req,
};
static void fractional_scale_resource_destroy(struct wl_resource *r) {
    struct surface *s = wl_resource_get_user_data(r);
    if (s) s->fractional_scale = NULL;
}
static void fractional_scale_mgr_destroy(struct wl_client *c,
                                         struct wl_resource *r) {
    wl_resource_destroy(r);
}
static void fractional_scale_mgr_get(struct wl_client *c, struct wl_resource *r,
                                     uint32_t id,
                                     struct wl_resource *surface) {
    struct surface *s = wl_resource_get_user_data(surface);
    if (s->fractional_scale) {
        wl_resource_post_error(
            r, WP_FRACTIONAL_SCALE_MANAGER_V1_ERROR_FRACTIONAL_SCALE_EXISTS,
            "the surface already has a fractional_scale object");
        return;
    }
    struct wl_resource *fs =
        wl_resource_create(c, &wp_fractional_scale_v1_interface, 1, id);
    if (!fs) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(fs, &fractional_scale_impl, s,
                                   fractional_scale_resource_destroy);
    s->fractional_scale = fs;
    /* wp_fractional_scale counts in 120ths, so an integer output scale is
     * scale x 120. The desktop advertises no fractional step of its own. */
    wp_fractional_scale_v1_send_preferred_scale(fs, (uint32_t)(g.scale * 120));
}
static const struct wp_fractional_scale_manager_v1_interface
    fractional_scale_mgr_impl = {
        .destroy = fractional_scale_mgr_destroy,
        .get_fractional_scale = fractional_scale_mgr_get,
};
static void fractional_scale_mgr_bind(struct wl_client *c, void *data,
                                      uint32_t ver, uint32_t id) {
    struct wl_resource *r = wl_resource_create(
        c, &wp_fractional_scale_manager_v1_interface, (int)ver, id);
    if (!r) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(r, &fractional_scale_mgr_impl, NULL, NULL);
}

/* ====================================================================== */
/* The selection: wl_data_device + zwlr/ext data-control                 */
/* ====================================================================== */

/* One clipboard per seat, the way every wlroots compositor keeps it: the
 * selection is a pointer to the source some client offered, plus the MIME
 * types it named. The compositor never holds clipboard bytes. A paste is
 * wl_data_offer.receive(mime, fd) from the receiving client, which we hand
 * on to the source client as wl_data_source.send(mime, fd); the two clients
 * then talk over that pipe directly (its write end crosses the Wayland
 * socket twice by SCM_RIGHTS).
 *
 * Three protocols set and read the same selection:
 *   - wl_data_device: an ordinary client sets it with the serial of the input
 *     event that caused the copy, and is offered it just before it takes
 *     keyboard focus (and again when it changes while focused).
 *   - ext_data_control_v1 and its deprecated wlroots predecessor
 *     zwlr_data_control_v1 (the same protocol under another name; wl-copy
 *     still speaks it): a clipboard tool with no window (a clipboard
 *     manager, Kandelo's host-clipboard agent kclipd) sets the selection
 *     without a serial and sees every change regardless of focus. Hyprland
 *     advertises both.
 *
 * Drag-and-drop and the primary selection are not implemented: start_drag
 * is a no-op, the offer's accept/finish/set_actions are accepted so v3
 * clients work, and neither primary-selection global is advertised. */

enum source_kind { SRC_DATA_DEVICE, SRC_WLR_CONTROL, SRC_EXT_CONTROL };

struct data_source {
    struct wl_resource *resource;   /* wl_data_source or a data-control source */
    enum source_kind kind;
    /* Offers name their source by this id, never by pointer: a source can be
     * destroyed while offers for it still exist, and a later source may be
     * allocated at the same address. */
    uint64_t id;
    char **mimes;
    int n_mimes;
    int used;                       /* passed to a set_selection already */
};

static struct {
    struct data_source *source;     /* the selection; NULL when empty */
    uint32_t serial;                /* serial the current selection was set with */
    uint64_t next_id;
    /* The client libwayland is tearing down, from its destroy signal until a
     * new client takes its address. Its resources are destroyed while
     * libwayland walks its object map, so a selection offer created for it
     * then (focus can fall to its own next surface) would grow that map
     * mid-walk. */
    struct wl_client *dying;
    struct wl_list devices;         /* wl_data_device resources, all clients */
    /* Data-control device resources of both flavours; user data is
     * CONTROL_EXT for ext_data_control_device_v1, NULL for zwlr. */
    struct wl_list control_devices;
} sel;

static const struct wl_data_offer_interface data_offer_impl;
static const struct zwlr_data_control_offer_v1_interface control_offer_impl;
static const struct ext_data_control_offer_v1_interface ext_control_offer_impl;
#define CONTROL_EXT ((void *)1)

static void data_source_add_mime(struct data_source *src, const char *mime) {
    for (int i = 0; i < src->n_mimes; i++)
        if (!strcmp(src->mimes[i], mime)) return;
    char **grown = realloc(src->mimes, (size_t)(src->n_mimes + 1) * sizeof(*grown));
    char *copy = strdup(mime);
    if (!grown || !copy) {
        free(copy);
        if (grown) src->mimes = grown;
        wl_resource_post_no_memory(src->resource);
        return;
    }
    src->mimes = grown;
    src->mimes[src->n_mimes++] = copy;
}

/* Offer the current selection on one wl_data_device: data_offer, one offer
 * event per MIME type, then selection. An empty selection is selection(NULL),
 * which tells the client its old offer is gone. */
static void data_device_send_selection(struct wl_resource *dev) {
    struct wl_client *c = wl_resource_get_client(dev);
    if (!sel.source) {
        wl_data_device_send_selection(dev, NULL);
        return;
    }
    struct wl_resource *offer = wl_resource_create(
        c, &wl_data_offer_interface, wl_resource_get_version(dev), 0);
    if (!offer) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(offer, &data_offer_impl,
                                   (void *)(uintptr_t)sel.source->id, NULL);
    wl_data_device_send_data_offer(dev, offer);
    for (int i = 0; i < sel.source->n_mimes; i++)
        wl_data_offer_send_offer(offer, sel.source->mimes[i]);
    wl_data_device_send_selection(dev, offer);
}

static void control_device_send_selection(struct wl_resource *dev) {
    struct wl_client *c = wl_resource_get_client(dev);
    int ext = wl_resource_get_user_data(dev) == CONTROL_EXT;
    if (!sel.source) {
        if (ext) ext_data_control_device_v1_send_selection(dev, NULL);
        else zwlr_data_control_device_v1_send_selection(dev, NULL);
        return;
    }
    struct wl_resource *offer = wl_resource_create(
        c, ext ? &ext_data_control_offer_v1_interface
               : &zwlr_data_control_offer_v1_interface, 1, 0);
    if (!offer) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(
        offer, ext ? (const void *)&ext_control_offer_impl
                   : (const void *)&control_offer_impl,
        (void *)(uintptr_t)sel.source->id, NULL);
    if (ext) {
        ext_data_control_device_v1_send_data_offer(dev, offer);
        for (int i = 0; i < sel.source->n_mimes; i++)
            ext_data_control_offer_v1_send_offer(offer, sel.source->mimes[i]);
        ext_data_control_device_v1_send_selection(dev, offer);
    } else {
        zwlr_data_control_device_v1_send_data_offer(dev, offer);
        for (int i = 0; i < sel.source->n_mimes; i++)
            zwlr_data_control_offer_v1_send_offer(offer, sel.source->mimes[i]);
        zwlr_data_control_device_v1_send_selection(dev, offer);
    }
}

/* Offer the selection to every wl_data_device `client` holds. Called just
 * before that client receives keyboard focus, as the protocol requires: a
 * client that pastes on its first key press must already have the offer. */
static void selection_send_to_client(struct wl_client *client) {
    if (client == sel.dying) return;
    for_each_seat_res(dev, &sel.devices, client)
        data_device_send_selection(dev);
}

/* The selection changed: the focused client and every data-control device
 * learn about it. Unfocused ordinary clients hear on their next focus. */
static void selection_broadcast(void) {
    if (g.kbd_focus) selection_send_to_client(g.kbd_focus->client);
    struct wl_resource *dev;
    wl_resource_for_each(dev, &sel.control_devices)
        if (wl_resource_get_client(dev) != sel.dying)
            control_device_send_selection(dev);
}

static void source_send_cancelled(struct data_source *src) {
    switch (src->kind) {
    case SRC_DATA_DEVICE: wl_data_source_send_cancelled(src->resource); break;
    case SRC_WLR_CONTROL:
        zwlr_data_control_source_v1_send_cancelled(src->resource);
        break;
    case SRC_EXT_CONTROL:
        ext_data_control_source_v1_send_cancelled(src->resource);
        break;
    }
}

/* Install `src` (NULL clears) as the selection. The source it replaces is
 * told it is cancelled; its client then destroys it. */
static void selection_set(struct data_source *src, uint32_t serial) {
    if (src) src->used = 1;
    if (sel.source == src) return;
    struct data_source *old = sel.source;
    sel.source = src;
    sel.serial = serial;
    if (old) source_send_cancelled(old);
    if (src)
        printf("SELECTION_SET via=%s mimes=%d\n",
               src->kind == SRC_DATA_DEVICE   ? "data-device"
               : src->kind == SRC_EXT_CONTROL ? "ext-data-control"
                                              : "data-control",
               src->n_mimes);
    else
        printf("SELECTION_CLEARED\n");
    fflush(stdout);
    selection_broadcast();
}

/* A paste: forward the receiver's fd to the source's client and drop ours.
 * libwayland dups the fd into the outgoing event, so closing here leaves the
 * source client's copy and the receiver's read end as the only holders. An
 * offer whose source is no longer the selection gets the fd closed at once,
 * and the reader sees EOF: there is nothing left to paste. */
static void offer_receive(uint64_t source_id, const char *mime, int32_t fd) {
    struct data_source *src = sel.source;
    if (src && src->id == source_id) {
        switch (src->kind) {
        case SRC_DATA_DEVICE:
            wl_data_source_send_send(src->resource, mime, fd);
            break;
        case SRC_WLR_CONTROL:
            zwlr_data_control_source_v1_send_send(src->resource, mime, fd);
            break;
        case SRC_EXT_CONTROL:
            ext_data_control_source_v1_send_send(src->resource, mime, fd);
            break;
        }
        printf("SELECTION_RECEIVE mime=%s\n", mime);
    } else {
        printf("SELECTION_RECEIVE_STALE mime=%s\n", mime);
    }
    fflush(stdout);
    close(fd);
}

static void data_source_resource_destroy(struct wl_resource *r) {
    struct data_source *src = wl_resource_get_user_data(r);
    if (!src) return;
    if (sel.source == src) {
        sel.source = NULL;
        printf("SELECTION_CLEARED\n");
        fflush(stdout);
        selection_broadcast();
    }
    for (int i = 0; i < src->n_mimes; i++) free(src->mimes[i]);
    free(src->mimes);
    free(src);
}

static struct data_source *data_source_create(struct wl_client *c,
                                              const struct wl_interface *iface,
                                              int version, uint32_t id,
                                              const void *impl,
                                              enum source_kind kind) {
    struct data_source *src = calloc(1, sizeof(*src));
    if (!src) { wl_client_post_no_memory(c); return NULL; }
    src->resource = wl_resource_create(c, iface, version, id);
    if (!src->resource) {
        free(src);
        wl_client_post_no_memory(c);
        return NULL;
    }
    src->kind = kind;
    src->id = ++sel.next_id;
    wl_resource_set_implementation(src->resource, impl, src,
                                   data_source_resource_destroy);
    return src;
}

/* ---- wl_data_source / wl_data_offer / wl_data_device ------------------- */

static void data_source_offer(struct wl_client *c, struct wl_resource *r,
                              const char *mime) {
    data_source_add_mime(wl_resource_get_user_data(r), mime);
}
static void data_source_destroy_req(struct wl_client *c,
                                    struct wl_resource *r) {
    wl_resource_destroy(r);
}
static void data_source_set_actions(struct wl_client *c, struct wl_resource *r,
                                    uint32_t actions) {}
static const struct wl_data_source_interface data_source_impl = {
    .offer = data_source_offer,
    .destroy = data_source_destroy_req,
    .set_actions = data_source_set_actions,
};

static void data_offer_accept(struct wl_client *c, struct wl_resource *r,
                              uint32_t serial, const char *mime) {}
static void data_offer_receive(struct wl_client *c, struct wl_resource *r,
                               const char *mime, int32_t fd) {
    offer_receive((uint64_t)(uintptr_t)wl_resource_get_user_data(r), mime, fd);
}
static void data_offer_destroy_req(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static void data_offer_finish(struct wl_client *c, struct wl_resource *r) {}
static void data_offer_set_actions(struct wl_client *c, struct wl_resource *r,
                                   uint32_t actions, uint32_t preferred) {}
static const struct wl_data_offer_interface data_offer_impl = {
    .accept = data_offer_accept,
    .receive = data_offer_receive,
    .destroy = data_offer_destroy_req,
    .finish = data_offer_finish,
    .set_actions = data_offer_set_actions,
};

static void data_device_start_drag(struct wl_client *c, struct wl_resource *r,
                                   struct wl_resource *source,
                                   struct wl_resource *origin,
                                   struct wl_resource *icon, uint32_t serial) {}

/* Serials are compared modulo 2^32, the way wlroots does: a request quoting a
 * serial older than the current selection's lost a race with a newer copy
 * (two keystrokes in flight, say) and is dropped, not applied out of order. */
static int serial_is_older(uint32_t a, uint32_t b) {
    return a != b && (uint32_t)(b - a) < UINT32_MAX / 2;
}

static void data_device_set_selection(struct wl_client *c,
                                      struct wl_resource *r,
                                      struct wl_resource *source,
                                      uint32_t serial) {
    if (sel.source && serial_is_older(serial, sel.serial)) {
        printf("SELECTION_STALE serial=%u current=%u\n", serial, sel.serial);
        fflush(stdout);
        return;
    }
    selection_set(source ? wl_resource_get_user_data(source) : NULL, serial);
}
static void data_device_release(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static const struct wl_data_device_interface data_device_impl = {
    .start_drag = data_device_start_drag,
    .set_selection = data_device_set_selection,
    .release = data_device_release,
};
static void data_device_resource_destroy(struct wl_resource *r) {
    wl_list_remove(wl_resource_get_link(r));
}

static void data_dm_create_source(struct wl_client *c, struct wl_resource *r,
                                  uint32_t id) {
    data_source_create(c, &wl_data_source_interface, wl_resource_get_version(r),
                       id, &data_source_impl, SRC_DATA_DEVICE);
}
static void data_dm_get_device(struct wl_client *c, struct wl_resource *r,
                               uint32_t id, struct wl_resource *seat) {
    struct wl_resource *dev = wl_resource_create(
        c, &wl_data_device_interface, wl_resource_get_version(r), id);
    if (!dev) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(dev, &data_device_impl, NULL,
                                   data_device_resource_destroy);
    wl_list_insert(&sel.devices, wl_resource_get_link(dev));
    /* A client that already holds focus (foot creates its data device after
     * its keyboard) must still see the selection before it can paste. */
    if (g.kbd_focus && g.kbd_focus->client == c)
        data_device_send_selection(dev);
}
static const struct wl_data_device_manager_interface data_dm_impl = {
    .create_data_source = data_dm_create_source,
    .get_data_device = data_dm_get_device,
};
static void data_dm_bind(struct wl_client *c, void *data, uint32_t ver,
                         uint32_t id) {
    struct wl_resource *r =
        wl_resource_create(c, &wl_data_device_manager_interface, (int)ver, id);
    if (!r) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(r, &data_dm_impl, NULL, NULL);
}

/* ---- data-control: zwlr_data_control_manager_v1 + ext_data_control_v1 -- */

/* The two protocols are the same requests and events under different
 * names, with the same error values, so one set of request handlers serves
 * both; only the interface tables and the event senders differ. */

static void control_source_offer(struct wl_client *c, struct wl_resource *r,
                                 const char *mime) {
    struct data_source *src = wl_resource_get_user_data(r);
    if (src->used) {
        /* == EXT_DATA_CONTROL_SOURCE_V1_ERROR_INVALID_OFFER */
        wl_resource_post_error(r, ZWLR_DATA_CONTROL_SOURCE_V1_ERROR_INVALID_OFFER,
                               "offer sent after set_selection");
        return;
    }
    data_source_add_mime(src, mime);
}
static void control_source_destroy_req(struct wl_client *c,
                                       struct wl_resource *r) {
    wl_resource_destroy(r);
}
static const struct zwlr_data_control_source_v1_interface control_source_impl = {
    .offer = control_source_offer,
    .destroy = control_source_destroy_req,
};

static void control_offer_receive(struct wl_client *c, struct wl_resource *r,
                                  const char *mime, int32_t fd) {
    offer_receive((uint64_t)(uintptr_t)wl_resource_get_user_data(r), mime, fd);
}
static void control_offer_destroy_req(struct wl_client *c,
                                      struct wl_resource *r) {
    wl_resource_destroy(r);
}
static const struct zwlr_data_control_offer_v1_interface control_offer_impl = {
    .receive = control_offer_receive,
    .destroy = control_offer_destroy_req,
};

static void control_device_set_selection(struct wl_client *c,
                                         struct wl_resource *r,
                                         struct wl_resource *source) {
    struct data_source *src = source ? wl_resource_get_user_data(source) : NULL;
    if (src && src->used) {
        /* == EXT_DATA_CONTROL_DEVICE_V1_ERROR_USED_SOURCE */
        wl_resource_post_error(r, ZWLR_DATA_CONTROL_DEVICE_V1_ERROR_USED_SOURCE,
                               "source was already used");
        return;
    }
    /* No input event caused this, so there is no client serial to check; a
     * fresh one orders it after every selection set so far. */
    selection_set(src, wl_display_next_serial(g.display));
}
/* Primary selection is not implemented, and the protocol says to ignore the
 * request when it is not. */
static void control_device_set_primary_selection(struct wl_client *c,
                                                 struct wl_resource *r,
                                                 struct wl_resource *source) {}
static void control_device_destroy_req(struct wl_client *c,
                                       struct wl_resource *r) {
    wl_resource_destroy(r);
}
static const struct zwlr_data_control_device_v1_interface control_device_impl = {
    .set_selection = control_device_set_selection,
    .destroy = control_device_destroy_req,
    .set_primary_selection = control_device_set_primary_selection,
};

static const struct ext_data_control_source_v1_interface ext_control_source_impl = {
    .offer = control_source_offer,
    .destroy = control_source_destroy_req,
};
static const struct ext_data_control_offer_v1_interface ext_control_offer_impl = {
    .receive = control_offer_receive,
    .destroy = control_offer_destroy_req,
};
static const struct ext_data_control_device_v1_interface ext_control_device_impl = {
    .set_selection = control_device_set_selection,
    .destroy = control_device_destroy_req,
    .set_primary_selection = control_device_set_primary_selection,
};

static void control_mgr_create_source(struct wl_client *c,
                                      struct wl_resource *r, uint32_t id) {
    data_source_create(c, &zwlr_data_control_source_v1_interface, 1, id,
                       &control_source_impl, SRC_WLR_CONTROL);
}
static void ext_control_mgr_create_source(struct wl_client *c,
                                          struct wl_resource *r, uint32_t id) {
    data_source_create(c, &ext_data_control_source_v1_interface, 1, id,
                       &ext_control_source_impl, SRC_EXT_CONTROL);
}
static void control_device_create(struct wl_client *c, struct wl_resource *r,
                                  uint32_t id, int ext) {
    struct wl_resource *dev = wl_resource_create(
        c, ext ? &ext_data_control_device_v1_interface
               : &zwlr_data_control_device_v1_interface,
        wl_resource_get_version(r), id);
    if (!dev) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(
        dev, ext ? (const void *)&ext_control_device_impl
                 : (const void *)&control_device_impl,
        ext ? CONTROL_EXT : NULL, data_device_resource_destroy);
    wl_list_insert(&sel.control_devices, wl_resource_get_link(dev));
    /* "The first selection event is sent upon binding the device." */
    control_device_send_selection(dev);
}
static void control_mgr_get_device(struct wl_client *c, struct wl_resource *r,
                                   uint32_t id, struct wl_resource *seat) {
    control_device_create(c, r, id, 0);
}
static void ext_control_mgr_get_device(struct wl_client *c,
                                       struct wl_resource *r, uint32_t id,
                                       struct wl_resource *seat) {
    control_device_create(c, r, id, 1);
}
static void control_mgr_destroy(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static const struct zwlr_data_control_manager_v1_interface control_mgr_impl = {
    .create_data_source = control_mgr_create_source,
    .get_data_device = control_mgr_get_device,
    .destroy = control_mgr_destroy,
};
static void control_mgr_bind(struct wl_client *c, void *data, uint32_t ver,
                             uint32_t id) {
    struct wl_resource *r = wl_resource_create(
        c, &zwlr_data_control_manager_v1_interface, (int)ver, id);
    if (!r) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(r, &control_mgr_impl, NULL, NULL);
}
static const struct ext_data_control_manager_v1_interface ext_control_mgr_impl = {
    .create_data_source = ext_control_mgr_create_source,
    .get_data_device = ext_control_mgr_get_device,
    .destroy = control_mgr_destroy,
};
static void ext_control_mgr_bind(struct wl_client *c, void *data, uint32_t ver,
                                 uint32_t id) {
    struct wl_resource *r = wl_resource_create(
        c, &ext_data_control_manager_v1_interface, (int)ver, id);
    if (!r) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(r, &ext_control_mgr_impl, NULL, NULL);
}

/* ====================================================================== */
/* GPU compositing: GLES quads over imported client textures              */
/* ====================================================================== */

/* One quad per draw: the vertex shader expands gl_VertexID (triangle
 * strip, no VBO) across a uniform NDC rect; the fragment shader samples
 * the surface texture or fills a flat color for the focus border. An
 * XRGB/ARGB texture holds [B,G,R,X] bytes uploaded verbatim as RGBA, so it
 * is read with the .bgr swizzle exactly like the host's webgl2-scanout
 * presenter; an XBGR/ABGR one already holds RGBA order and is read as is
 * (see glc_tex_mode). */
static const char GLC_VS[] =
    "#version 300 es\n"
    "uniform vec4 u_rect;\n"
    "uniform vec4 u_uv;\n"
    "out vec2 v_uv;\n"
    "void main() {\n"
    "  vec2 t = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));\n"
    "  v_uv = mix(u_uv.xy, u_uv.zw, t);\n"
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
    "  if (u_use_tex == 0) { o_color = u_color; return; }\n"
    "  vec4 t = texture(u_tex, v_uv);\n"
    "  vec3 c = u_use_tex >= 3 ? t.rgb : t.bgr;\n"
    "  o_color = vec4(c, (u_use_tex == 2 || u_use_tex == 4) ? t.a : 1.0);\n"
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

/* Device pixels → NDC rect, relative to the GL viewport (which is the
 * pixel grid, g.pw x g.ph). y0 is the TOP edge; v_uv row 0 maps to it,
 * matching the texture's top scanline. Callers holding a logical box
 * multiply by g.scale through glc_px(). */
static void glc_rect_ndc(int32_t x, int32_t y, int32_t w, int32_t h,
                         float out[4]) {
    out[0] = 2.0f * (float)x / (float)g.pw - 1.0f;
    out[1] = 1.0f - 2.0f * (float)y / (float)g.ph;
    out[2] = 2.0f * (float)(x + w) / (float)g.pw - 1.0f;
    out[3] = 1.0f - 2.0f * (float)(y + h) / (float)g.ph;
}

/* Logical unit → device pixel. */
static inline int32_t glc_px(int32_t v) { return v * (int32_t)g.scale; }

static void glc_draw_tex_rect(unsigned tex, int mode, int32_t x, int32_t y,
                              int32_t w, int32_t h, const float uv[4]) {
    float r[4];
    glc_rect_ndc(x, y, w, h, r);
    glUniform4f(glc.loc_rect, r[0], r[1], r[2], r[3]);
    glUniform4f(glc.loc_uv, uv[0], uv[1], uv[2], uv[3]);
    glUniform1i(glc.loc_use_tex, mode);
    glBindTexture(GL_TEXTURE_2D, tex);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
}

static void glc_draw_tex(unsigned tex, int mode, int32_t x, int32_t y,
                         int32_t w, int32_t h) {
    static const float full_uv[4] = { 0.0f, 0.0f, 1.0f, 1.0f };
    glc_draw_tex_rect(tex, mode, x, y, w, h, full_uv);
}

/* Destination box + source-uv rect for a surface's committed buffer under
 * its wp_viewport state (the full buffer when none). */
static void surface_draw_box(struct surface *s, struct shm_buffer *b,
                             int32_t *dw, int32_t *dh, float uv[4]) {
    surface_committed_size(s, b, dw, dh);
    if (s->vp_src_w > 0) {
        float x0 = (float)wl_fixed_to_double(s->vp_src_x);
        float y0 = (float)wl_fixed_to_double(s->vp_src_y);
        uv[0] = x0 / (float)b->width;
        uv[1] = y0 / (float)b->height;
        uv[2] = (x0 + (float)wl_fixed_to_double(s->vp_src_w)) / (float)b->width;
        uv[3] = (y0 + (float)wl_fixed_to_double(s->vp_src_h)) / (float)b->height;
    } else {
        uv[0] = uv[1] = 0.0f;
        uv[2] = uv[3] = 1.0f;
    }
    /* A y-inverted buffer stores the image bottom-up: mirror the source
     * rows so its top lands at the top of the destination box. */
    if (b->y_invert) {
        uv[1] = 1.0f - uv[1];
        uv[3] = 1.0f - uv[3];
    }
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
 * when the buffer has no GL representation; the caller draws the rest of
 * the frame without it. NOTE: rebinding flushes the cmdbuf, so this must
 * run BEFORE the frame's draw sequence starts — a flush mid-frame would
 * present a half-composited desktop. */
static unsigned shm_buffer_gl_texture(struct shm_buffer *b) {
    /* The texture is the whole imported bo, so a buffer that starts partway
     * into the pool has no GL representation — the CPU path reads it. */
    if (b->offset != 0) return 0;
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

/* The staging bo behind the wallpaper texture. Held for the process lifetime:
 * it owns the texture's pixels, and a theme switch rewrites it in place. */
static struct gbm_bo *wallpaper_bo;
static unsigned wallpaper_bo_handle;

/* Copy g.wallpaper into the staging bo and (re)bind it as the texture. A
 * rebind re-reads the bo, which is how a theme switch reaches the GPU path. */
static int gl_wallpaper_upload(void) {
    uint32_t stride = 0;
    void *map_data = NULL;
    uint32_t *px = gbm_bo_map(wallpaper_bo, 0, 0, g.pw, g.ph, 0, &stride,
                              &map_data);
    if (!px) return -1;
    for (uint32_t y = 0; y < g.ph; y++)
        memcpy(px + (size_t)y * (stride / 4), g.wallpaper + (size_t)y * g.pw,
               (size_t)g.pw * 4);
    gbm_bo_unmap(wallpaper_bo, map_data);   /* flushes the bytes into host storage */

    unsigned tex = wpkEglBindBoTexture(glc.dpy, wallpaper_bo_handle,
                                       GL_TEXTURE_2D);
    if (!tex) return -1;
    glc.wallpaper_tex = tex;
    return 0;
}

/* Stage the pre-rendered wallpaper through a dumb bo so the host uploads
 * it as a texture from shared storage — cmdbuf TLV records cap at 64 KB,
 * far below a framebuffer-sized glTexImage2D payload. */
static int setup_gl_wallpaper(void) {
    wallpaper_bo = gbm_bo_create(g.gbm, g.pw, g.ph,
                                 GBM_FORMAT_XRGB8888, GBM_BO_USE_LINEAR);
    if (!wallpaper_bo) return -1;
    int prime = gbm_bo_get_fd(wallpaper_bo);
    if (prime < 0) { gbm_bo_destroy(wallpaper_bo); return -1; }
    wallpaper_bo_handle = wpkEglImportDmabufHandle(glc.dpy, prime);
    close(prime);
    if (!wallpaper_bo_handle) { gbm_bo_destroy(wallpaper_bo); return -1; }
    if (gl_wallpaper_upload() != 0) {
        wpkEglCloseBoHandle(glc.dpy, wallpaper_bo_handle);
        gbm_bo_destroy(wallpaper_bo);
        return -1;
    }
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
    const EGLint srf_attrs[] = { EGL_WIDTH, (EGLint)g.pw,
                                 EGL_HEIGHT, (EGLint)g.ph, EGL_NONE };
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
    glc.loc_uv = glGetUniformLocation(glc.prog, "u_uv");
    glc.loc_use_tex = glGetUniformLocation(glc.prog, "u_use_tex");
    glc.loc_color = glGetUniformLocation(glc.prog, "u_color");
    glUniform1i(glGetUniformLocation(glc.prog, "u_tex"), 0);
    glViewport(0, 0, (GLsizei)g.pw, (GLsizei)g.ph);
    /* Source-over with a premultiplied source, matching wl_shm ARGB8888.
     * Opaque draws emit alpha 1 and so still overwrite. */
    glEnable(GL_BLEND);
    glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA);

    if (setup_gl_wallpaper() != 0) {
        fprintf(stderr, "wlcompositor: GL wallpaper staging failed\n");
        eglTerminate(glc.dpy);
        return;
    }
    glc.active = 1;
}

/* GPU frame: refresh dirty textures (host-side uploads, safe to flush),
 * then encode clear + wallpaper + z-ordered window quads and present
 * them in ONE cmdbuf flush via eglSwapBuffers. Returns 0 only when the
 * GL session itself failed, so repaint() can fall back to the CPU blit.
 *
 * A single buffer without a GL representation is NOT such a failure: a
 * cursor image sits at a non-zero offset in its pool (libwayland-cursor
 * packs a whole theme into one pool), and tearing the session down for
 * it would drop the entire desktop onto the CPU path for good. The draw
 * loops below skip a zero texture, which is what the collection loops
 * leave behind. */
static int repaint_gl(void) {
    struct surface *top = NULL;
    for (int i = 0; i < g.n_surfaces; i++) {
        struct surface *s = g.zorder[i];
        s->frame_tex = 0;
        if (!surface_visible(s) || !s->buffer) continue;
        struct shm_buffer *b = wl_resource_get_user_data(s->buffer);
        if (!b) continue;
        s->frame_tex = shm_buffer_gl_texture(b);
    }
    for (int i = 0; i < g.n_layers; i++) {
        struct surface *s = g.layers[i];
        s->frame_tex = 0;
        if (!surface_visible(s) || !s->buffer) continue;
        struct shm_buffer *b = wl_resource_get_user_data(s->buffer);
        if (!b) continue;
        s->frame_tex = shm_buffer_gl_texture(b);
    }

    glClearColor(0.0f, 0.0f, 0.0f, 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    if (lk.locked) {
        /* A locked output is opaque black under the lock surface alone. */
        if (lk.surface && lk.surface->buffer) {
            struct shm_buffer *b = wl_resource_get_user_data(lk.surface->buffer);
            unsigned t = b ? shm_buffer_gl_texture(b) : 0;
            if (t) glc_draw_tex(t, glc_tex_mode(b), 0, 0, (int32_t)g.pw, (int32_t)g.ph);
        }
        return eglSwapBuffers(glc.dpy, glc.srf) == EGL_TRUE;
    }
    glc_draw_tex(glc.wallpaper_tex, GLC_TEX_OPAQUE, 0, 0, (int32_t)g.pw, (int32_t)g.ph);
    for (int i = 0; i < g.n_layers; i++)
        if (g.layers[i]->frame_tex && layer_in_band(g.layers[i], 0))
            glc_draw_tex(g.layers[i]->frame_tex, layer_tex_mode(g.layers[i]),
                         glc_px(g.layers[i]->x),
                         glc_px(g.layers[i]->y),
                         glc_px(g.layers[i]->w), glc_px(g.layers[i]->h));
    for (int i = 0; i < g.n_surfaces; i++) {
        struct surface *s = g.zorder[i];
        if (!surface_visible(s) || !s->buffer || !s->frame_tex) continue;
        struct shm_buffer *b = wl_resource_get_user_data(s->buffer);
        if (!b) continue;
        int32_t dw, dh;
        float uv[4];
        surface_draw_box(s, b, &dw, &dh, uv);
        if (g.kbd_focus == s)   /* 2px accent ring behind the window */
            glc_draw_solid(th.border_active, glc_px(s->x - 2), glc_px(s->y - 2),
                           glc_px(dw + 4), glc_px(dh + 4));
        glc_draw_tex_rect(s->frame_tex, glc_tex_mode(b), glc_px(s->x), glc_px(s->y),
                          glc_px(dw), glc_px(dh), uv);
        /* One-shot per window: the GL renderer drew this window's own
         * texture. Every protocol marker (map, focus, tile, frame callback)
         * still fires for a window whose pool the GPU cannot import — the
         * collection loop leaves a zero texture and the window is skipped
         * silently. The browser gate polls this marker by app_id. */
        if (s->xdg_toplevel && !s->gl_drawn) {
            printf("GLDRAW app_id=%s\n", s->app_id);
            fflush(stdout);
            s->gl_drawn = 1;
        }
        for (int j = 0; j < g.n_all_surfaces; j++) {
            struct surface *sub = g.all_surfaces[j];
            if (sub->parent != s || !surface_visible(sub) || !sub->buffer)
                continue;
            struct shm_buffer *sb = wl_resource_get_user_data(sub->buffer);
            if (!sb) continue;
            unsigned t = shm_buffer_gl_texture(sb);
            if (!t) continue;
            sub->x = s->x + sub->sub_x;
            sub->y = s->y + sub->sub_y;
            int32_t sdw, sdh;
            float suv[4];
            surface_draw_box(sub, sb, &sdw, &sdh, suv);
            glc_draw_tex_rect(t, glc_tex_mode(sb), glc_px(sub->x),
                              glc_px(sub->y), glc_px(sdw), glc_px(sdh), suv);
        }
        top = s;
    }
    for (int i = 0; i < g.n_layers; i++)
        if (g.layers[i]->frame_tex && layer_in_band(g.layers[i], 1))
            glc_draw_tex(g.layers[i]->frame_tex, layer_tex_mode(g.layers[i]),
                         glc_px(g.layers[i]->x),
                         glc_px(g.layers[i]->y),
                         glc_px(g.layers[i]->w), glc_px(g.layers[i]->h));
    /* A failed present (context loss) must degrade like a failed texture
     * bind — returning 1 here would keep glc.active set and freeze the
     * canvas on the last GL frame, the exact failure the CPU fallback
     * exists to prevent. */
    if (eglSwapBuffers(glc.dpy, glc.srf) != EGL_TRUE) return 0;

    /* One-shot proof that client pixels crossed the process boundary,
     * same contract as the CPU path's sample — but read back from the
     * composited GL framebuffer (glReadPixels via the sync query path). */
    if (top && !g.sampled) {
        /* The sample point is logical (the gates read these coordinates);
         * the framebuffer it is read from is device pixels. */
        int32_t sx = top->x + 10, sy = top->y + 10;
        if (sx >= 0 && sx < (int32_t)g.width && sy >= 0 &&
            sy < (int32_t)g.height) {
            int32_t px_x = sx * (int32_t)g.scale, px_y = sy * (int32_t)g.scale;
            uint8_t px[4] = {0};
            glReadPixels(px_x, (int32_t)g.ph - 1 - px_y, 1, 1, GL_RGBA,
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
            gbm_bo_map(bo, 0, 0, g.pw, g.ph, 0, &stride, &map_data);
        if (!dst) {
            /* A persistent map failure would freeze the desktop with no
             * visible error — say so loudly. */
            fprintf(stderr, "wlcompositor: gbm_bo_map failed: %s\n",
                    strerror(errno));
            gbm_surface_release_buffer(g.gbm_surface, bo);
            return;
        }
        uint32_t stride_px = stride / 4;

        struct surface *top = NULL;
        if (lk.locked) {
            for (uint32_t y = 0; y < g.ph; y++)
                memset(dst + (size_t)y * stride_px, 0, (size_t)g.pw * 4);
            if (lk.surface) blit_surface(lk.surface, dst, stride_px);
        } else {
        for (uint32_t y = 0; y < g.ph; y++)
            memcpy(dst + (size_t)y * stride_px,
                   g.wallpaper + (size_t)y * g.pw, (size_t)g.pw * 4);

        for (int i = 0; i < g.n_layers; i++)
            if (layer_in_band(g.layers[i], 0))
                blit_surface(g.layers[i], dst, stride_px);
        for (int i = 0; i < g.n_surfaces; i++) {
            struct surface *s = g.zorder[i];
            if (!surface_visible(s)) continue;
            if (g.kbd_focus == s) draw_focus_border(s, dst, stride_px);
            blit_surface(s, dst, stride_px);
            blit_subsurfaces(s, dst, stride_px);
            top = s;
        }
        for (int i = 0; i < g.n_layers; i++)
            if (layer_in_band(g.layers[i], 1))
                blit_surface(g.layers[i], dst, stride_px);
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
                       dst[(size_t)(sy * (int32_t)g.scale) * stride_px
                           + sx * (int32_t)g.scale]);
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
        /* SetCrtc has no flip event, so stamp the first frame ourselves. */
        struct timespec ts;
        clock_gettime(CLOCK_MONOTONIC, &ts);
        send_all_presentation_feedback((uint32_t)ts.tv_sec,
                                       (uint32_t)ts.tv_nsec, 0);
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
        send_all_presentation_feedback(sec, usec * 1000u, seq);
        /* The frame that just flipped was drawn locked, so nothing unlocked
         * is visible any more: only now may the lock client hear `locked`. */
        if (lk.announce && lk.lock) {
            lk.announce = 0;
            ext_session_lock_v1_send_locked(lk.lock);
            printf("SESSION_LOCKED\n");
            fflush(stdout);
        }
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
    if (xkb_state_mod_name_is_active(g.xkb_state, XKB_MOD_NAME_ALT,
                                     XKB_STATE_MODS_EFFECTIVE) > 0) m |= MOD_ALT;
    return m;
}

/* Move keyboard focus to the next/prev visible window in z-order WITHOUT
 * reordering (so a tiled layout keeps its geometry as focus cycles). */
static void focus_cycle(int dir) {
    int n = 0, cur = -1;
    for (int i = 0; i < g.n_surfaces; i++)
        if (surface_visible(g.zorder[i])) {
            if (g.zorder[i] == g.kbd_focus) cur = n;
            n++;
        }
    if (n == 0) return;
    int next = cur < 0 ? 0 : (cur + dir + n) % n;
    for (int i = 0, k = 0; i < g.n_surfaces; i++)
        if (surface_visible(g.zorder[i]) && k++ == next) {
            kbd_set_focus(g.zorder[i]);
            break;
        }
    ptr_refresh_focus();
}

/* swapwindow l|r|u|d (Hyprland's dispatcher): swap the focused tile with
 * its nearest neighbour in that direction — among tiles overlapping it on
 * the other axis — by exchanging their places in the tiling order. */
static void swap_window(char dir) {
    struct surface *f = g.kbd_focus;
    if (g.layout == LAYOUT_FLOATING || !f || !f->xdg_toplevel || !surface_visible(f))
        return;
    int fi = -1, best = -1;
    long best_d = 0;
    for (int i = 0; i < g.n_surfaces; i++) {
        struct surface *s = g.zorder[i];
        if (s == f) { fi = i; continue; }
        if (!s->xdg_toplevel || !surface_visible(s)) continue;
        int vert_overlap = s->y < f->y + f->h && f->y < s->y + s->h;
        int horiz_overlap = s->x < f->x + f->w && f->x < s->x + s->w;
        long d;
        switch (dir) {
        case 'l': if (!vert_overlap || s->x >= f->x) continue; d = f->x - s->x; break;
        case 'r': if (!vert_overlap || s->x <= f->x) continue; d = s->x - f->x; break;
        case 'u': if (!horiz_overlap || s->y >= f->y) continue; d = f->y - s->y; break;
        case 'd': if (!horiz_overlap || s->y <= f->y) continue; d = s->y - f->y; break;
        default: return;
        }
        if (best < 0 || d < best_d) { best = i; best_d = d; }
    }
    if (fi < 0 || best < 0) return;
    g.zorder[fi] = g.zorder[best];
    g.zorder[best] = f;
    printf("SWAP dir=%c\n", dir);
    fflush(stdout);
    retile();
}

/* ---- window tags + sendshortcut ---------------------------------------- */

/* Tag names in first-use order; a surface's tag bit i means tag_names[i]. */
static char tag_names[MAX_TAGS][32];
static int n_tags;
/* `windowrule = tag +NAME, class:REGEX`: the regex must match the whole
 * app_id (Hyprland matches the class in full), so it is compiled anchored. */
static struct { regex_t re; int tag; } window_rules[MAX_WINDOW_RULES];
static int n_window_rules;

static int tag_index(const char *name) {
    for (int i = 0; i < n_tags; i++)
        if (!strcmp(tag_names[i], name)) return i;
    if (n_tags >= MAX_TAGS || strlen(name) >= sizeof(tag_names[0])) return -1;
    snprintf(tag_names[n_tags], sizeof(tag_names[0]), "%s", name);
    return n_tags++;
}

/* Re-derive a window's tags from its app_id; called whenever it changes. */
static void apply_window_rules(struct surface *s) {
    s->tags = 0;
    for (int i = 0; i < n_window_rules; i++)
        if (regexec(&window_rules[i].re, s->app_id, 0, NULL, 0) == 0)
            s->tags |= 1u << window_rules[i].tag;
}

static int focused_has_tag(int tag) {
    return g.kbd_focus && tag >= 0 && (g.kbd_focus->tags & (1u << tag));
}

/* MOD_* bits as an xkb depressed-modifier mask for this keymap. */
static uint32_t xkb_mods_for(uint32_t mods) {
    static const struct { uint32_t bit; const char *name; } names[] = {
        { MOD_SUPER, XKB_MOD_NAME_LOGO }, { MOD_SHIFT, XKB_MOD_NAME_SHIFT },
        { MOD_CTRL, XKB_MOD_NAME_CTRL },  { MOD_ALT, XKB_MOD_NAME_ALT },
    };
    struct xkb_keymap *km = xkb_state_get_keymap(g.xkb_state);
    uint32_t mask = 0;
    for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
        if (!(mods & names[i].bit)) continue;
        xkb_mod_index_t idx = xkb_keymap_mod_get_index(km, names[i].name);
        if (idx != XKB_MOD_INVALID) mask |= 1u << idx;
    }
    return mask;
}

/* The evdev keycode whose base-level keysym is `sym`, or 0. */
static uint32_t keycode_for_keysym(xkb_keysym_t sym) {
    struct xkb_keymap *km = xkb_state_get_keymap(g.xkb_state);
    for (xkb_keycode_t kc = xkb_keymap_min_keycode(km);
         kc <= xkb_keymap_max_keycode(km); kc++) {
        const xkb_keysym_t *syms;
        if (kc >= 8 &&
            xkb_keymap_key_get_syms_by_level(km, kc, 0, 0, &syms) > 0 &&
            syms[0] == sym)
            return kc - 8;
    }
    return 0;
}

/* Hyprland's sendshortcut: deliver a chord to the focused surface as
 * wl_keyboard events. The modifiers are sent EXPLICITLY, not merged with the
 * ones physically held: SUPER+V must reach foot as Ctrl+Shift+V, and if the
 * still-held SUPER leaked into the chord foot would see Super+Ctrl+Shift+V
 * and match nothing (the problem Omarchy's clipboard.lua describes). The
 * real modifier state is restored afterwards, so the next physical key is
 * interpreted correctly. Locked modifiers (Caps/Num Lock) are kept. */
static void send_shortcut(const struct shortcut *sc) {
    struct surface *s = g.kbd_focus;
    if (!s) return;
    uint32_t key = keycode_for_keysym(sc->sym);
    if (!key) {
        fprintf(stderr, "wlcompositor: sendshortcut: no key for keysym 0x%x\n",
                sc->sym);
        return;
    }
    uint32_t dep, lat, lock, grp;
    current_mods(&dep, &lat, &lock, &grp);
    uint32_t chord = xkb_mods_for(sc->mods);
    uint32_t t = now_ms();
    uint32_t s_mods = wl_display_next_serial(g.display);
    uint32_t s_down = wl_display_next_serial(g.display);
    uint32_t s_up = wl_display_next_serial(g.display);
    uint32_t s_restore = wl_display_next_serial(g.display);
    for_each_seat_res(res, &g.keyboards, s->client) {
        wl_keyboard_send_modifiers(res, s_mods, chord, 0, lock, grp);
        wl_keyboard_send_key(res, s_down, t, key, WL_KEYBOARD_KEY_STATE_PRESSED);
        wl_keyboard_send_key(res, s_up, t, key, WL_KEYBOARD_KEY_STATE_RELEASED);
        wl_keyboard_send_modifiers(res, s_restore, dep, lat, lock, grp);
    }
    printf("SENDSHORTCUT app_id=%s mods=0x%x key=%u\n", s->app_id, sc->mods, key);
    fflush(stdout);
}

static void run_dispatch(const struct keybind *b) {
    switch (b->action) {
    case ACT_EXEC: {
        char tmp[sizeof b->param];
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
    case ACT_THEME:        theme_switch(b->param); break;
    case ACT_SWAP:         swap_window(b->param[0]); break;
    case ACT_SEND_SHORTCUT: send_shortcut(&b->shortcut[0]); break;
    case ACT_SEND_SHORTCUT_IF_TAG:
        send_shortcut(&b->shortcut[focused_has_tag(b->arg) ? 0 : 1]);
        break;
    case ACT_GLOBAL:       break;   /* try_keybind fires it with the key */
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
        if (state != WL_KEYBOARD_KEY_STATE_PRESSED) return 1;
        if (g.binds[i].action == ACT_GLOBAL)
            global_shortcut_press(g.binds[i].param, key);
        else
            run_dispatch(&g.binds[i]);
        return 1;
    }
    return 0;
}

/* ---- config parsing ----------------------------------------------------- */

/* Returns the new bind, or NULL when it was refused. */
static struct keybind *add_bind(uint32_t mods, xkb_keysym_t sym, int action,
                                int arg, const char *param) {
    if (g.n_binds >= MAX_BINDS) {
        fprintf(stderr, "wlcompositor: more than %d binds; ignoring the rest\n", MAX_BINDS);
        return NULL;
    }
    struct keybind *b = &g.binds[g.n_binds++];
    b->mods = mods;
    b->sym = sym;
    b->action = action;
    b->arg = arg;
    /* A command that does not fit would run truncated — a different,
     * usually missing, program — so refuse the bind loudly instead. */
    if (param && strlen(param) >= sizeof(b->param)) {
        fprintf(stderr, "wlcompositor: bind command too long (%zu bytes, max %zu): %s\n",
                strlen(param), sizeof(b->param) - 1, param);
        g.n_binds--;
        return NULL;
    }
    snprintf(b->param, sizeof(b->param), "%s", param ? param : "");
    memset(b->shortcut, 0, sizeof(b->shortcut));
    return b;
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

/* ---- theme loading ------------------------------------------------------ */

static void render_wallpaper(void);
static int gl_wallpaper_upload(void);

/* Parse `0xRRGGBB` / `#RRGGBB` / a decimal integer. Returns the ARGB color
 * with a forced-opaque alpha, or `fallback` when the text is not a number. */
static uint32_t parse_color(const char *s, uint32_t fallback) {
    if (*s == '#') s++;
    char *end = NULL;
    unsigned long v = strtoul(s, &end, 16);
    if (end == s) return fallback;
    return 0xff000000u | (uint32_t)(v & 0xffffffu);
}

/* Read one theme's palette. Unknown keys are ignored, so the same file can
 * carry the client-side colors (bar, foreground, accent) that kbar and
 * klauncher read for themselves. */
static int theme_load(const char *name) {
    const char *root = getenv("WLC_THEME_DIR");
    char path[256];
    snprintf(path, sizeof(path), "%s/%s/theme.conf", root ? root : THEME_DIR,
             name);
    FILE *f = fopen(path, "r");
    if (!f) return -1;

    th.wallpaper_path[0] = '\0';   /* a gradient theme sheds the old image */
    char line[256];
    while (fgets(line, sizeof(line), f)) {
        char *s = trim(line);
        if (*s == '\0' || *s == '#') continue;
        char *eq = strchr(s, '=');
        if (!eq) continue;
        *eq = '\0';
        char *key = trim(s);
        char *val = trim(eq + 1);
        if (!strcmp(key, "border_active"))
            th.border_active = parse_color(val, th.border_active);
        else if (!strcmp(key, "wallpaper_top"))
            th.wallpaper_top = parse_color(val, th.wallpaper_top);
        else if (!strcmp(key, "wallpaper_bottom"))
            th.wallpaper_bottom = parse_color(val, th.wallpaper_bottom);
        else if (!strcmp(key, "wallpaper")) {
            if (val[0] == '/')
                snprintf(th.wallpaper_path, sizeof(th.wallpaper_path), "%s",
                         val);
            else
                snprintf(th.wallpaper_path, sizeof(th.wallpaper_path),
                         "%s/%s/%s", root ? root : THEME_DIR, name, val);
        }
        else if (!strcmp(key, "gaps_in"))  th.gaps_in = atoi(val);
        else if (!strcmp(key, "gaps_out")) th.gaps_out = atoi(val);
    }
    fclose(f);
    snprintf(th.name, sizeof(th.name), "%s", name);
    for (int i = 0; i < th.n_installed; i++)
        if (!strcmp(th.installed[i], name)) { th.current = i; break; }
    return 0;
}

/* List the installed themes, sorted, so cycling has a stable order. A theme is
 * a directory holding a theme.conf; anything else in the root is skipped. */
static void theme_scan(void) {
    const char *root = getenv("WLC_THEME_DIR");
    if (!root) root = THEME_DIR;
    DIR *d = opendir(root);
    if (!d) return;
    struct dirent *e;
    while ((e = readdir(d)) && th.n_installed < MAX_THEMES) {
        if (e->d_name[0] == '.') continue;
        char probe[512];
        snprintf(probe, sizeof(probe), "%s/%s/theme.conf", root, e->d_name);
        if (access(probe, R_OK) != 0) continue;
        int at = th.n_installed;
        while (at > 0 && strcmp(th.installed[at - 1], e->d_name) > 0) {
            memcpy(th.installed[at], th.installed[at - 1],
                   sizeof(th.installed[0]));
            at--;
        }
        snprintf(th.installed[at], sizeof(th.installed[0]), "%s", e->d_name);
        th.n_installed++;
    }
    closedir(d);
}

/* Push the loaded palette into the live desktop: border color, gaps, and the
 * wallpaper (re-uploaded when the GPU path owns it). Clients re-read the theme
 * themselves when they see the event. */
static void theme_apply(void) {
    tile_gap_inner = th.gaps_in;
    tile_gap_outer = th.gaps_out;
    render_wallpaper();
    if (glc.active && gl_wallpaper_upload() != 0)
        fprintf(stderr, "wlcompositor: theme wallpaper upload failed\n");
    retile();
    schedule_repaint();
    printf("THEME %s\n", th.name);
    fflush(stdout);
    kwlctl_emit("theme>>%s", th.name);
    /* The `notify =` hook is how Omarchy surfaces a switch (its scripts call
     * notify-send); ours spawns the configured notifier with the new name. */
    if (th.notify[0]) {
        char cmd[sizeof(th.notify) + 48];
        snprintf(cmd, sizeof(cmd), "%s Theme %s", th.notify, th.name);
        kwlctl_exec(cmd);
    }
}

/* `theme <name>`, or `next`/`prev` to cycle the installed set. */
static int theme_switch(const char *arg) {
    if (!strcmp(arg, "next") || !strcmp(arg, "prev")) {
        if (th.n_installed == 0) return -1;
        int step = arg[0] == 'n' ? 1 : th.n_installed - 1;
        int next = (th.current < 0 ? 0 : (th.current + step) % th.n_installed);
        if (theme_load(th.installed[next]) != 0) return -1;
    } else if (theme_load(arg) != 0) {
        return -1;
    }
    theme_apply();
    return 0;
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
        else if (!strcasecmp(tok, "ALT") || !strcasecmp(tok, "MOD1"))
            m |= MOD_ALT;
        else return -1;
    }
    *out = m;
    return 0;
}

/* Split `s` at commas into at most `max` trimmed fields; the last field
 * keeps any further commas. Returns the field count. */
static int split_fields(char *s, char **out, int max) {
    int n = 0;
    while (n < max) {
        char *comma = n < max - 1 ? strchr(s, ',') : NULL;
        if (comma) *comma = '\0';
        out[n++] = trim(s);
        if (!comma) break;
        s = comma + 1;
    }
    return n;
}

/* A MODS field and a KEY field as a shortcut. Returns -1 when either is
 * not a modifier list or a key name. */
static int parse_shortcut(char *mods, const char *key, struct shortcut *out) {
    if (parse_mods(mods, &out->mods) < 0) return -1;
    out->sym = xkb_keysym_to_lower(
        xkb_keysym_from_name(key, XKB_KEYSYM_CASE_INSENSITIVE));
    return out->sym == XKB_KEY_NoSymbol ? -1 : 0;
}

/* The sendshortcut dispatchers' arguments, for a bind or `kwlctl dispatch`:
 *   sendshortcut      MODS, KEY[, WINDOW]
 *   kandelo:sendshortcutiftag TAG, TAGGED_MODS, TAGGED_KEY, MODS, KEY
 * Hyprland's WINDOW target is not supported; it must be empty (the focused
 * surface, which is what Omarchy uses). kandelo:sendshortcutiftag has no Hyprland
 * equivalent: it stands in for the Lua function in Omarchy's clipboard.lua
 * that picks a chord by whether the focused window is tagged `terminal`.
 * Returns -1 and writes nothing usable on a malformed argument list. */
static int parse_shortcut_args(int action, char *args, struct keybind *b) {
    char *f[5];
    if (action == ACT_SEND_SHORTCUT) {
        int n = split_fields(args, f, 3);
        if (n < 2 || (n == 3 && f[2][0] != '\0')) return -1;
        return parse_shortcut(f[0], f[1], &b->shortcut[0]);
    }
    if (split_fields(args, f, 5) != 5 || f[0][0] == '\0') return -1;
    b->arg = tag_index(f[0]);
    if (b->arg < 0) return -1;
    if (parse_shortcut(f[1], f[2], &b->shortcut[0]) < 0) return -1;
    return parse_shortcut(f[3], f[4], &b->shortcut[1]);
}

/* Parse one `bind = MODS, KEY, DISPATCHER[, ARGS]` line into the table. ARGS
 * is the rest of the line, commas included, as in Hyprland. */
static void parse_bind_line(char *rhs) {
    char *fields[4];
    int nf = split_fields(rhs, fields, 4);
    if (nf < 3) return;

    uint32_t mods;
    if (parse_mods(fields[0], &mods) < 0) return;
    /* Match against the base-level keysym, which is lowercase for letters
     * ("w", not "W"). xkb_keysym_from_name("W") resolves to the uppercase
     * keysym, so fold to lower or a config `bind = CTRL, W` never fires. */
    xkb_keysym_t sym = xkb_keysym_to_lower(
        xkb_keysym_from_name(fields[1], XKB_KEYSYM_CASE_INSENSITIVE));
    if (sym == XKB_KEY_NoSymbol) return;

    const char *disp = fields[2];
    static char no_arg[1];
    char *arg = nf > 3 ? fields[3] : no_arg;
    if (!strcmp(disp, "exec"))            add_bind(mods, sym, ACT_EXEC, 0, arg);
    else if (!strcmp(disp, "workspace"))  add_bind(mods, sym, ACT_WORKSPACE, atoi(arg), NULL);
    else if (!strcmp(disp, "movetoworkspace")) add_bind(mods, sym, ACT_MOVE_TO_WS, atoi(arg), NULL);
    else if (!strcmp(disp, "killactive")) add_bind(mods, sym, ACT_KILL, 0, NULL);
    else if (!strcmp(disp, "cyclenext"))  add_bind(mods, sym, ACT_CYCLE_NEXT, 0, NULL);
    else if (!strcmp(disp, "cycleprev"))  add_bind(mods, sym, ACT_CYCLE_PREV, 0, NULL);
    else if (!strcmp(disp, "theme"))      add_bind(mods, sym, ACT_THEME, 0, arg);
    else if (!strcmp(disp, "swapwindow")) add_bind(mods, sym, ACT_SWAP, 0, arg);
    else if (!strcmp(disp, "sendshortcut") ||
             !strcmp(disp, DISP_SENDSHORTCUT_IF_TAG)) {
        int action = strcmp(disp, "sendshortcut") ? ACT_SEND_SHORTCUT_IF_TAG
                                                  : ACT_SEND_SHORTCUT;
        struct keybind parsed = {0};
        if (parse_shortcut_args(action, arg, &parsed) < 0) {
            fprintf(stderr, "wlcompositor: malformed %s bind; ignoring it\n", disp);
            return;
        }
        struct keybind *b = add_bind(mods, sym, action, parsed.arg, NULL);
        if (b) memcpy(b->shortcut, parsed.shortcut, sizeof(parsed.shortcut));
    }
    else if (!strcmp(disp, "global"))     add_bind(mods, sym, ACT_GLOBAL, 0, arg);
}

/* Parse `windowrule = tag +NAME, class:REGEX` (the windowrulev2 spelling is
 * the same). Tags are the only rule, and the class (app_id) the only
 * matcher; anything else is refused loudly rather than half-applied. */
static void parse_windowrule_line(char *rhs) {
    char *f[2];
    char *line_copy = strdup(rhs);
    int ok = split_fields(rhs, f, 2) == 2 && !strncmp(f[0], "tag +", 5) &&
             !strncmp(f[1], "class:", 6) && n_window_rules < MAX_WINDOW_RULES;
    int tag = ok ? tag_index(trim(f[0] + 5)) : -1;
    if (tag >= 0) {
        const char *re = f[1] + 6;
        size_t len = strlen(re) + 5;
        char *anchored = malloc(len);
        if (anchored) {
            snprintf(anchored, len, "^(%s)$", re);
            ok = regcomp(&window_rules[n_window_rules].re, anchored,
                         REG_EXTENDED | REG_NOSUB) == 0;
            free(anchored);
        } else {
            ok = 0;
        }
        if (ok) window_rules[n_window_rules++].tag = tag;
    }
    if (tag < 0 || !ok)
        fprintf(stderr, "wlcompositor: unsupported windowrule; ignoring: %s\n",
                line_copy ? line_copy : "");
    free(line_copy);
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
            char *eq = strchr(s, '=');
            if (!eq) continue;
            if (strncmp(s, "bind", 4) == 0) parse_bind_line(trim(eq + 1));
            else if (strncmp(s, "windowrule", 10) == 0)
                parse_windowrule_line(trim(eq + 1));
            else if (strncmp(s, "theme", 5) == 0) theme_load(trim(eq + 1));
            else if (strncmp(s, "notify", 6) == 0)
                snprintf(th.notify, sizeof(th.notify), "%s", trim(eq + 1));
        }
        fclose(f);
        src = path;
    }
    printf("BINDS_LOADED n=%d source=%s\n", g.n_binds, src);
    if (n_window_rules) printf("WINDOWRULES_LOADED n=%d\n", n_window_rules);
    printf("THEME %s\n", th.name);
    fflush(stdout);
    tile_gap_inner = th.gaps_in;
    tile_gap_outer = th.gaps_out;
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

    idle_activity();
    if (g.shortcut_pressed && key == g.shortcut_key &&
        state == WL_KEYBOARD_KEY_STATE_RELEASED) {
        shortcut_send(g.shortcut_pressed, 0);
        g.shortcut_pressed = NULL;
        return;
    }
    /* Compositor keybinds intercept the key before the focused client — but
     * not while the session is locked: the lock surface owns the keyboard. */
    if (!lk.locked && try_keybind(key, state)) return;

    if (!g.kbd_focus) return;
    for_each_seat_res(res, &g.keyboards, g.kbd_focus->client) {
        wl_keyboard_send_key(res, serial, t, key, state);
        if (mods_changed)
            wl_keyboard_send_modifiers(res, serial, dep, lat, lock, grp);
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
        for_each_seat_res(res, &g.pointers, g.ptr_focus->client) {
            wl_pointer_send_motion(res, t, lx, ly);
            ptr_send_frame(res);
        }
    }
    /* No repaint on bare motion: with no software cursor the desktop is
     * pixel-identical until a client commits in response. */
}

static void handle_pointer_motion_abs(struct libinput_event_pointer *p) {
    idle_activity();
    g.cursor_x = libinput_event_pointer_get_absolute_x_transformed(p, g.width);
    g.cursor_y = libinput_event_pointer_get_absolute_y_transformed(p, g.height);
    pointer_moved();
}

static void handle_pointer_motion_rel(struct libinput_event_pointer *p) {
    /* The bridge measures its deltas in the canvas's device pixels — the
     * mode — while the cursor lives on the logical grid, so they divide by
     * the output scale. Without that a scale-2 desktop moves the pointer
     * twice as far as the mouse and a dragged window runs away from it.
     * The absolute path above needs no division: get_absolute_*_transformed
     * normalizes into whatever range it is handed, and it is handed the
     * logical one. */
    idle_activity();
    double dx = libinput_event_pointer_get_dx(p) / (double)g.scale;
    double dy = libinput_event_pointer_get_dy(p) / (double)g.scale;
    g.cursor_x += dx;
    g.cursor_y += dy;
    if (g.cursor_x < 0) g.cursor_x = 0;
    if (g.cursor_y < 0) g.cursor_y = 0;
    if (g.cursor_x > g.width) g.cursor_x = g.width;
    if (g.cursor_y > g.height) g.cursor_y = g.height;
    pointer_moved();
}

static void handle_pointer_button(struct libinput_event_pointer *p) {
    uint32_t button = libinput_event_pointer_get_button(p);
    int pressed = libinput_event_pointer_get_button_state(p) ==
                  LIBINPUT_BUTTON_STATE_PRESSED;
    uint32_t state = pressed ? WL_POINTER_BUTTON_STATE_PRESSED
                             : WL_POINTER_BUTTON_STATE_RELEASED;
    idle_activity();
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
         * stays pinned to the pressed surface.
         *
         * An exclusive layer-shell grab is the one thing a click cannot take
         * the keyboard from: wlr-layer-shell-v1 gives the top-most exclusive
         * surface on the top and overlay layers focus unconditionally, so
         * that a lock screen or password prompt cannot be clicked past. The
         * map path applies the same guard. Raising is stacking rather than
         * focus, so it still runs. */
        struct surface *s = surface_at(g.cursor_x, g.cursor_y);
        if (s) {
            zorder_raise(s);
            if (!layer_kb_grab() || s->lock_surface) kbd_set_focus(s);
        }
        ptr_refresh_focus();
    }

    if (g.ptr_focus) {
        uint32_t serial = wl_display_next_serial(g.display);
        uint32_t t = now_ms();
        if (pressed && was_down == 0) g.press_serial = serial;
        for_each_seat_res(res, &g.pointers, g.ptr_focus->client) {
            wl_pointer_send_button(res, serial, t, button, state);
            ptr_send_frame(res);
        }
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

/* ====================================================================== */
/* hyprland_global_shortcuts_v1 — key combinations owned for a client      */
/* ====================================================================== */

/* A `bind = MODS, KEY, global, app_id:id` line fires the shortcut a client
 * registered under that app_id and id — how Quickshell's GlobalShortcut
 * reaches the desktop's keys under Hyprland. The compositor keeps the key
 * and reports press and release; the client decides what they mean. */

static struct global_shortcut *shortcut_find(const char *app_id, const char *id) {
    struct global_shortcut *sc;
    wl_list_for_each(sc, &g.shortcuts, link)
        if (!strcmp(sc->app_id, app_id) && !strcmp(sc->id, id)) return sc;
    return NULL;
}

static void shortcut_send(struct global_shortcut *sc, int pressed) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    uint32_t hi = (uint32_t)((uint64_t)ts.tv_sec >> 32);
    uint32_t lo = (uint32_t)ts.tv_sec;
    uint32_t ns = (uint32_t)ts.tv_nsec;
    if (pressed) hyprland_global_shortcut_v1_send_pressed(sc->resource, hi, lo, ns);
    else hyprland_global_shortcut_v1_send_released(sc->resource, hi, lo, ns);
    printf("SHORTCUT_%s app=%s id=%s\n", pressed ? "PRESSED" : "RELEASED",
           sc->app_id, sc->id);
    fflush(stdout);
}

static void global_shortcut_press(const char *param, uint32_t key) {
    char app_id[64];
    const char *colon = strchr(param, ':');
    if (!colon) {
        fprintf(stderr, "wlcompositor: global bind needs app_id:id, got %s\n", param);
        return;
    }
    snprintf(app_id, sizeof(app_id), "%.*s", (int)(colon - param), param);
    struct global_shortcut *sc = shortcut_find(app_id, colon + 1);
    if (!sc) {
        printf("SHORTCUT_UNBOUND app=%s id=%s\n", app_id, colon + 1);
        fflush(stdout);
        return;
    }
    shortcut_send(sc, 1);
    g.shortcut_pressed = sc;
    g.shortcut_key = key;
}

static void shortcut_destroy_req(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static const struct hyprland_global_shortcut_v1_interface shortcut_impl = {
    .destroy = shortcut_destroy_req,
};
static void shortcut_resource_destroy(struct wl_resource *r) {
    struct global_shortcut *sc = wl_resource_get_user_data(r);
    if (!sc) return;
    if (g.shortcut_pressed == sc) g.shortcut_pressed = NULL;
    wl_list_remove(&sc->link);
    free(sc);
}

static void shortcuts_mgr_register(struct wl_client *client,
                                   struct wl_resource *r, uint32_t id,
                                   const char *shortcut_id, const char *app_id,
                                   const char *description,
                                   const char *trigger_description) {
    if (shortcut_find(app_id, shortcut_id)) {
        wl_resource_post_error(r, HYPRLAND_GLOBAL_SHORTCUTS_MANAGER_V1_ERROR_ALREADY_TAKEN,
                               "shortcut %s:%s is already registered", app_id,
                               shortcut_id);
        return;
    }
    struct global_shortcut *sc = calloc(1, sizeof(*sc));
    if (!sc) { wl_client_post_no_memory(client); return; }
    struct wl_resource *res = wl_resource_create(
        client, &hyprland_global_shortcut_v1_interface,
        wl_resource_get_version(r), id);
    if (!res) { free(sc); wl_client_post_no_memory(client); return; }
    sc->resource = res;
    snprintf(sc->app_id, sizeof(sc->app_id), "%s", app_id);
    snprintf(sc->id, sizeof(sc->id), "%s", shortcut_id);
    wl_resource_set_implementation(res, &shortcut_impl, sc,
                                   shortcut_resource_destroy);
    wl_list_insert(&g.shortcuts, &sc->link);
    printf("SHORTCUT_REGISTERED app=%s id=%s\n", sc->app_id, sc->id);
    fflush(stdout);
}
static void shortcuts_mgr_destroy(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static const struct hyprland_global_shortcuts_manager_v1_interface shortcuts_mgr_impl = {
    .register_shortcut = shortcuts_mgr_register,
    .destroy = shortcuts_mgr_destroy,
};
static void shortcuts_mgr_bind(struct wl_client *client, void *data,
                               uint32_t version, uint32_t id) {
    struct wl_resource *r = wl_resource_create(
        client, &hyprland_global_shortcuts_manager_v1_interface, version, id);
    if (!r) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(r, &shortcuts_mgr_impl, NULL, NULL);
}

/* ====================================================================== */
/* ext_idle_notifier_v1 — "the user has been idle for N ms"               */
/* ====================================================================== */

/* Each notification runs its own timer from the last input event; input
 * from the keyboard or pointer counts as activity. No idle inhibitor exists
 * here (the compositor does not offer zwp_idle_inhibit_manager_v1), so the
 * two request kinds behave the same. */

static int idle_timer_fired(void *data) {
    struct idle_notification *n = data;
    if (n->idled) return 0;
    n->idled = 1;
    ext_idle_notification_v1_send_idled(n->resource);
    printf("IDLE timeout=%u idled\n", n->timeout_ms);
    fflush(stdout);
    return 0;
}

static void idle_activity(void) {
    struct idle_notification *n;
    wl_list_for_each(n, &g.idle_notifications, link) {
        if (n->idled) {
            n->idled = 0;
            ext_idle_notification_v1_send_resumed(n->resource);
            printf("IDLE timeout=%u resumed\n", n->timeout_ms);
            fflush(stdout);
        }
        /* A zero timeout means "as soon as the seat is inactive"; 0 would
         * disarm the timer instead. */
        wl_event_source_timer_update(n->timer, n->timeout_ms ? (int)n->timeout_ms : 1);
    }
}

static void idle_notification_destroy_req(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static const struct ext_idle_notification_v1_interface idle_notification_impl = {
    .destroy = idle_notification_destroy_req,
};
static void idle_notification_resource_destroy(struct wl_resource *r) {
    struct idle_notification *n = wl_resource_get_user_data(r);
    if (!n) return;
    wl_event_source_remove(n->timer);
    wl_list_remove(&n->link);
    free(n);
}

static void idle_notifier_get(struct wl_client *client, struct wl_resource *r,
                              uint32_t id, uint32_t timeout,
                              struct wl_resource *seat) {
    struct idle_notification *n = calloc(1, sizeof(*n));
    if (!n) { wl_client_post_no_memory(client); return; }
    n->timer = wl_event_loop_add_timer(g.loop, idle_timer_fired, n);
    if (!n->timer) { free(n); wl_client_post_no_memory(client); return; }
    struct wl_resource *res = wl_resource_create(
        client, &ext_idle_notification_v1_interface, wl_resource_get_version(r), id);
    if (!res) {
        wl_event_source_remove(n->timer);
        free(n);
        wl_client_post_no_memory(client);
        return;
    }
    n->resource = res;
    n->timeout_ms = timeout;
    wl_resource_set_implementation(res, &idle_notification_impl, n,
                                   idle_notification_resource_destroy);
    wl_list_insert(&g.idle_notifications, &n->link);
    wl_event_source_timer_update(n->timer, timeout ? (int)timeout : 1);
    printf("IDLE_NOTIFICATION timeout=%u\n", timeout);
    fflush(stdout);
}
static void idle_notifier_destroy(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static const struct ext_idle_notifier_v1_interface idle_notifier_impl = {
    .destroy = idle_notifier_destroy,
    .get_idle_notification = idle_notifier_get,
    .get_input_idle_notification = idle_notifier_get,
};
static void idle_notifier_bind(struct wl_client *client, void *data,
                               uint32_t version, uint32_t id) {
    struct wl_resource *r = wl_resource_create(
        client, &ext_idle_notifier_v1_interface, version, id);
    if (!r) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(r, &idle_notifier_impl, NULL, NULL);
}

/* ====================================================================== */
/* ext_session_lock_v1 — the lock screen                                   */
/* ====================================================================== */

/* Keyboard and pointer focus after the lock surface goes away or the session
 * unlocks: the exclusive layer surface if one holds the keyboard, else the
 * top window. */
static void lock_focus_restore(void) {
    struct surface *grab = layer_kb_grab();
    kbd_set_focus(grab ? grab : topmost_on_ws(g.active_ws));
    ptr_refresh_focus();
}

static void lock_surface_destroy_req(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static void lock_surface_ack_configure(struct wl_client *c, struct wl_resource *r,
                                       uint32_t serial) {
    struct surface *s = wl_resource_get_user_data(r);
    if (!s) return;
    if (serial != s->configure_serial) {
        wl_resource_post_error(r, EXT_SESSION_LOCK_SURFACE_V1_ERROR_INVALID_SERIAL,
                               "ack of serial %u, configure was %u", serial,
                               s->configure_serial);
        return;
    }
    s->lock_acked = 1;
}
static const struct ext_session_lock_surface_v1_interface lock_surface_impl = {
    .destroy = lock_surface_destroy_req,
    .ack_configure = lock_surface_ack_configure,
};
static void lock_surface_resource_destroy(struct wl_resource *r) {
    struct surface *s = wl_resource_get_user_data(r);
    if (!s) return;
    s->lock_surface = NULL;
    s->lock_acked = 0;
    s->mapped = 0;
    if (lk.role_surface == s) lk.role_surface = NULL;
    if (lk.surface == s) {
        lk.surface = NULL;
        /* The output falls back to solid black until the client maps a new
         * one or the session unlocks. */
        if (lk.locked) {
            printf("LOCK_SURFACE_GONE\n");
            fflush(stdout);
        }
    }
    if (g.kbd_focus == s) {
        g.kbd_focus = NULL;
        if (!lk.locked) lock_focus_restore();
    }
    if (g.ptr_focus == s) g.ptr_focus = NULL;
    s->n_frame_cbs = 0;
    schedule_repaint();
}

static void lock_get_lock_surface(struct wl_client *client, struct wl_resource *r,
                                  uint32_t id, struct wl_resource *surface,
                                  struct wl_resource *output) {
    struct surface *s = wl_resource_get_user_data(surface);
    if (s->xdg_surface || s->layer_surface || s->lock_surface || s->subsurface) {
        wl_resource_post_error(r, EXT_SESSION_LOCK_V1_ERROR_ROLE,
                               "surface already has a role");
        return;
    }
    if (s->buffer || s->pending_buffer) {
        wl_resource_post_error(r, EXT_SESSION_LOCK_V1_ERROR_ALREADY_CONSTRUCTED,
                               "surface already has a buffer");
        return;
    }
    if (lk.role_surface) {
        wl_resource_post_error(r, EXT_SESSION_LOCK_V1_ERROR_DUPLICATE_OUTPUT,
                               "the output already has a lock surface");
        return;
    }
    struct wl_resource *res = wl_resource_create(
        client, &ext_session_lock_surface_v1_interface, wl_resource_get_version(r), id);
    if (!res) { wl_client_post_no_memory(client); return; }
    s->lock_surface = res;
    s->lock_acked = 0;
    lk.role_surface = s;
    snprintf(s->app_id, sizeof(s->app_id), "session-lock");
    wl_resource_set_implementation(res, &lock_surface_impl, s,
                                   lock_surface_resource_destroy);
    /* Exact requirement: the lock surface covers the whole logical output. */
    s->configure_serial = wl_display_next_serial(g.display);
    ext_session_lock_surface_v1_send_configure(res, s->configure_serial,
                                               g.width, g.height);
}

static void lock_unlock_and_destroy(struct wl_client *c, struct wl_resource *r) {
    if (r != lk.lock || !lk.locked || lk.announce) {
        wl_resource_post_error(r, EXT_SESSION_LOCK_V1_ERROR_INVALID_UNLOCK,
                               "unlock without a locked event");
        return;
    }
    lk.locked = 0;
    lk.lock = NULL;
    printf("SESSION_UNLOCKED\n");
    fflush(stdout);
    /* Whatever the lock surface held goes back to the desktop; the lock
     * surface itself stays mapped until the client destroys it, hidden by
     * the unlocked render order. */
    if (g.kbd_focus && g.kbd_focus->lock_surface) g.kbd_focus = NULL;
    lock_focus_restore();
    schedule_repaint();
    wl_resource_destroy(r);
}
static void lock_destroy_req(struct wl_client *c, struct wl_resource *r) {
    if (r == lk.lock && lk.locked) {
        wl_resource_post_error(r, EXT_SESSION_LOCK_V1_ERROR_INVALID_DESTROY,
                               "destroy while locked; use unlock_and_destroy");
        return;
    }
    wl_resource_destroy(r);
}
static const struct ext_session_lock_v1_interface lock_impl = {
    .destroy = lock_destroy_req,
    .get_lock_surface = lock_get_lock_surface,
    .unlock_and_destroy = lock_unlock_and_destroy,
};
static void lock_resource_destroy(struct wl_resource *r) {
    if (lk.lock != r) return;
    lk.lock = NULL;
    lk.announce = 0;
    if (lk.locked) {
        printf("SESSION_LOCK_CLIENT_GONE\n");
        fflush(stdout);
    }
}

static void lock_mgr_lock(struct wl_client *client, struct wl_resource *r,
                          uint32_t id) {
    struct wl_resource *res = wl_resource_create(
        client, &ext_session_lock_v1_interface, wl_resource_get_version(r), id);
    if (!res) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(res, &lock_impl, NULL, lock_resource_destroy);
    if (lk.lock) {
        ext_session_lock_v1_send_finished(res);
        printf("SESSION_LOCK_REFUSED\n");
        fflush(stdout);
        return;
    }
    lk.lock = res;
    lk.locked = 1;
    lk.announce = 1;
    /* Blank now; `locked` follows once that frame is on screen (on_flip).
     * Input stops reaching the desktop from this point. */
    kbd_set_focus(lk.surface);
    ptr_refresh_focus();
    schedule_repaint();
}
static void lock_mgr_destroy(struct wl_client *c, struct wl_resource *r) {
    wl_resource_destroy(r);
}
static const struct ext_session_lock_manager_v1_interface lock_mgr_impl = {
    .destroy = lock_mgr_destroy,
    .lock = lock_mgr_lock,
};
static void lock_mgr_bind(struct wl_client *client, void *data,
                          uint32_t version, uint32_t id) {
    struct wl_resource *r = wl_resource_create(
        client, &ext_session_lock_manager_v1_interface, version, id);
    if (!r) { wl_client_post_no_memory(client); return; }
    wl_resource_set_implementation(r, &lock_mgr_impl, NULL, NULL);
}

static void client_destroyed(struct wl_listener *listener, void *data) {
    free(listener);
    sel.dying = data;
    if (--g.client_count <= 0 && g.had_client) {
        printf("COMPOSITOR_LAST_CLIENT_GONE\n");
        fflush(stdout);
        wl_display_terminate(g.display);
    }
}
static void client_created(struct wl_listener *listener, void *data) {
    struct wl_client *client = data;
    if (sel.dying == client) sel.dying = NULL;   /* address reused */
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
     * Backspace, Escape, both Shifts, Controls, Alts and Supers, plus F1-F12 and the
     * nav cluster (Home/End/PgUp/PgDn/Insert/Delete) for full-screen
     * terminal apps. Two levels (base / Shift) via TWO_LEVEL; the bare
     * action keys are ONE_LEVEL. */
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
        "    <LALT> = 64;\n"    /* evdev KEY_LEFTALT (56) + 8 */
        /* The right-hand modifiers. A browser reports a Caps Lock that macOS
         * remaps to Control as ControlRight, so without <RCTL> that key
         * modified nothing and no CTRL bind fired. */
        "    <RCTL> = 105;\n"   /* evdev KEY_RIGHTCTRL (97) + 8 */
        "    <RALT> = 108;\n"   /* evdev KEY_RIGHTALT (100) + 8 */
        "    <RWIN> = 134;\n"   /* evdev KEY_RIGHTMETA (126) + 8 */
        "    <UP> = 111;  <LEFT> = 113;  <RGHT> = 114;  <DOWN> = 116;\n"
        "    <FK01> = 67;  <FK02> = 68;  <FK03> = 69;  <FK04> = 70;\n"
        "    <FK05> = 71;  <FK06> = 72;  <FK07> = 73;  <FK08> = 74;\n"
        "    <FK09> = 75;  <FK10> = 76;  <FK11> = 95;  <FK12> = 96;\n"
        "    <HOME> = 110;  <PGUP> = 112;  <END> = 115;  <PGDN> = 117;\n"
        "    <INS> = 118;  <DELE> = 119;\n"
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
        "    interpret Control_R+AnyOfOrNone(all) {\n"
        "      action = SetMods(modifiers=Control);\n"
        "    };\n"
        "    interpret Super_L+AnyOfOrNone(all) {\n"
        "      action = SetMods(modifiers=Mod4);\n"
        "    };\n"
        "    interpret Super_R+AnyOfOrNone(all) {\n"
        "      action = SetMods(modifiers=Mod4);\n"
        "    };\n"
        "    interpret Alt_L+AnyOfOrNone(all) {\n"
        "      action = SetMods(modifiers=Mod1);\n"
        "    };\n"
        "    interpret Alt_R+AnyOfOrNone(all) {\n"
        "      action = SetMods(modifiers=Mod1);\n"
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
        "    key <LALT> { [ Alt_L ] };\n"
        "    key <RCTL> { [ Control_R ] };\n"
        "    key <RALT> { [ Alt_R ] };\n"
        "    key <RWIN> { [ Super_R ] };\n"
        "    key <UP>   { [ Up ] };\n"
        "    key <DOWN> { [ Down ] };\n"
        "    key <LEFT> { [ Left ] };\n"
        "    key <RGHT> { [ Right ] };\n"
        "    key <FK01> { [ F1 ] };   key <FK02> { [ F2 ] };\n"
        "    key <FK03> { [ F3 ] };   key <FK04> { [ F4 ] };\n"
        "    key <FK05> { [ F5 ] };   key <FK06> { [ F6 ] };\n"
        "    key <FK07> { [ F7 ] };   key <FK08> { [ F8 ] };\n"
        "    key <FK09> { [ F9 ] };   key <FK10> { [ F10 ] };\n"
        "    key <FK11> { [ F11 ] };  key <FK12> { [ F12 ] };\n"
        "    key <HOME> { [ Home ] };   key <END>  { [ End ] };\n"
        "    key <PGUP> { [ Prior ] };  key <PGDN> { [ Next ] };\n"
        "    key <INS>  { [ Insert ] }; key <DELE> { [ Delete ] };\n"
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
        "    modifier_map Control { <LCTL>, <RCTL> };\n"
        "    modifier_map Mod4 { <LWIN>, <RWIN> };\n"
        "    modifier_map Mod1 { <LALT>, <RALT> };\n"
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
    g.pw = g.mode.hdisplay;
    g.ph = g.mode.vdisplay;
    /* Output scale from the display's DPI when WLC_SCALE did not set it.
     * 96 dpi is scale 1 (the reference pixel), so the scale is the mode's
     * pixels per 96th of an inch, rounded to an integer and clamped. A
     * connector with no physical size (mm 0) keeps scale 1. */
    const char *scale_source = g.scale_explicit ? "env" : "default";
    if (!g.scale_explicit && conn->mmWidth > 0) {
        double ref_px = (double)conn->mmWidth * 96.0 / 25.4;
        long s = lround((double)g.pw / ref_px);
        if (s < 1) s = 1;
        if (s > MAX_OUTPUT_SCALE) s = MAX_OUTPUT_SCALE;
        g.scale = (uint32_t)s;
        scale_source = "connector";
    }
    g.mm_width = (int32_t)conn->mmWidth;
    g.mm_height = (int32_t)conn->mmHeight;
    printf("WLC_SCALE %u source=%s mm=%ux%u\n", g.scale, scale_source,
           conn->mmWidth, conn->mmHeight);
    fflush(stdout);
    /* A scale that does not divide the mode would put the logical grid's
     * right/bottom edge inside the last device pixel, so the layout could
     * place a window the scanout has no room for. Round the logical grid
     * down; the remainder stays unpainted background. */
    g.width = g.pw / g.scale;
    g.height = g.ph / g.scale;
    drmModeFreeConnector(conn);
    drmModeFreeResources(res);

    /* Scanout bos live on card0 directly: CREATE_DUMB handles from card0
     * are valid for ADDFB2 on card0, so no PRIME round-trip is needed. */
    g.gbm = gbm_create_device(g.card_fd);
    if (!g.gbm) { fprintf(stderr, "gbm_create_device\n"); return -1; }
    g.gbm_surface = gbm_surface_create(
        g.gbm, g.pw, g.ph, GBM_FORMAT_XRGB8888,
        GBM_BO_USE_SCANOUT | GBM_BO_USE_LINEAR);
    if (!g.gbm_surface) { fprintf(stderr, "gbm_surface_create\n"); return -1; }
    return 0;
}

/* A theme's image wallpaper: KWLP raw pixels ("KWLP", u32le width, u32le
 * height, then width*height u32le XRGB pixels), centre-cropped to the
 * output's aspect and bilinear-scaled to fill it. Raw pixels because nothing
 * in the compositor decodes PNG/JPEG: whoever stages the theme (the demo
 * page, a test) renders the image and writes the pixels. The crop is what
 * frees the stager from knowing the mode — it cannot, because the image is
 * baked into the VFS before the mode is picked. */
static int render_wallpaper_image(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return -1;
    uint8_t hdr[12];
    uint32_t sw = 0, sh = 0;
    if (fread(hdr, 1, 12, f) != 12 || memcmp(hdr, "KWLP", 4) != 0) goto fail;
    sw = hdr[4] | hdr[5] << 8 | hdr[6] << 16 | (uint32_t)hdr[7] << 24;
    sh = hdr[8] | hdr[9] << 8 | hdr[10] << 16 | (uint32_t)hdr[11] << 24;
    if (sw < 1 || sh < 1 || sw > 8192 || sh > 8192) goto fail;
    uint32_t *src = malloc((size_t)sw * sh * 4);
    if (!src) goto fail;
    if (fread(src, 4, (size_t)sw * sh, f) != (size_t)sw * sh) {
        free(src);
        goto fail;
    }
    fclose(f);

    /* The source rect the output samples: the axis the output is relatively
     * narrower in is used whole, the other is cropped equally on both sides. */
    uint32_t cw = sw, ch = sh;
    if ((uint64_t)sw * g.ph > (uint64_t)g.pw * sh)
        cw = (uint32_t)(((uint64_t)g.pw * sh) / g.ph);
    else
        ch = (uint32_t)(((uint64_t)g.ph * sw) / g.pw);
    if (cw < 1) cw = 1;
    if (ch < 1) ch = 1;
    uint32_t ox = (sw - cw) / 2, oy = (sh - ch) / 2;

    for (uint32_t y = 0; y < g.ph; y++) {
        uint32_t fy = oy * 256u +
            (g.ph > 1 ? (uint32_t)(((uint64_t)y * 256u * (ch - 1)) / (g.ph - 1)) : 0);
        uint32_t y0 = fy >> 8, wy = fy & 0xff;
        uint32_t y1 = y0 + 1 < sh ? y0 + 1 : y0;
        uint32_t *row = g.wallpaper + (size_t)y * g.pw;
        for (uint32_t x = 0; x < g.pw; x++) {
            uint32_t fx = ox * 256u +
                (g.pw > 1 ? (uint32_t)(((uint64_t)x * 256u * (cw - 1)) / (g.pw - 1)) : 0);
            uint32_t x0 = fx >> 8, wx = fx & 0xff;
            uint32_t x1 = x0 + 1 < sw ? x0 + 1 : x0;
            uint32_t p00 = src[(size_t)y0 * sw + x0], p01 = src[(size_t)y0 * sw + x1];
            uint32_t p10 = src[(size_t)y1 * sw + x0], p11 = src[(size_t)y1 * sw + x1];
            uint32_t px = 0xff000000u;
            for (int shift = 0; shift <= 16; shift += 8) {
                uint32_t t0 = ((p00 >> shift & 0xff) * (256 - wx) +
                               (p01 >> shift & 0xff) * wx) >> 8;
                uint32_t t1 = ((p10 >> shift & 0xff) * (256 - wx) +
                               (p11 >> shift & 0xff) * wx) >> 8;
                px |= ((t0 * (256 - wy) + t1 * wy) >> 8) << shift;
            }
            row[x] = px;
        }
    }
    free(src);
    printf("WALLPAPER image w=%u h=%u crop=%ux%u+%u+%u\n", sw, sh, cw, ch, ox, oy);
    fflush(stdout);
    return 0;

fail:
    fclose(f);
    return -1;
}

/* Paint the desktop background into g.wallpaper: the theme's image when it
 * has one, else a vertical gradient between the theme's two wallpaper colors,
 * a faint grid, and the wordmark. Re-run on every theme switch. */
static void render_wallpaper(void) {
    if (th.wallpaper_path[0] &&
        render_wallpaper_image(th.wallpaper_path) == 0)
        return;
    const uint32_t top = th.wallpaper_top, bot = th.wallpaper_bottom;
    for (uint32_t y = 0; y < g.ph; y++) {
        uint32_t t = g.ph > 1 ? (y * 256u) / (g.ph - 1) : 0;
        uint32_t rr = ((top >> 16) & 0xff) +
                      ((int)((bot >> 16) & 0xff) - (int)((top >> 16) & 0xff)) * (int)t / 256;
        uint32_t gg = ((top >> 8) & 0xff) +
                      ((int)((bot >> 8) & 0xff) - (int)((top >> 8) & 0xff)) * (int)t / 256;
        uint32_t bb = (top & 0xff) +
                      ((int)(bot & 0xff) - (int)(top & 0xff)) * (int)t / 256;
        uint32_t px = 0xff000000u | (rr << 16) | (gg << 8) | bb;
        uint32_t *row = g.wallpaper + (size_t)y * g.pw;
        for (uint32_t x = 0; x < g.pw; x++) row[x] = px;
    }

    struct wpk_surface wp =
        wpk_surface_wrap(g.wallpaper, (int)g.pw, (int)g.ph, 0);

    /* The wallpaper is drawn straight into the scanout, which is device
     * pixels, so every measurement here is multiplied by the output scale by
     * hand. wlcompositor must not call wpk_set_scale(): that setting is
     * process-wide and captured by wpk_surface_wrap / wpk_font_load_default at
     * call time, and the compositor wraps client buffers with the same
     * library. The font is loaded at the scaled size, so the glyphs rasterize
     * sharp rather than being magnified. */
    const int scale = (int)g.scale;

    /* Faint 120 logical-px grid. */
    const wpk_color grid = 0x0affffffu;   /* ~4% white */
    for (uint32_t x = 0; x < g.pw; x += 120 * (uint32_t)scale)
        wpk_rect(&wp, (int)x, 0, scale, (int)g.ph, grid);
    for (uint32_t y = 0; y < g.ph; y += 120 * (uint32_t)scale)
        wpk_rect(&wp, 0, (int)y, (int)g.pw, scale, grid);

    struct wpk_font *big = wpk_font_load_default(56 * scale);
    struct wpk_font *small = wpk_font_load_default(20 * scale);
    if (big) {
        wpk_text(&wp, big, 96 * scale, (int)g.ph - 150 * scale, "Kandelo",
                 WPK_RGB(0x3e, 0x4a, 0x66));
        wpk_font_destroy(big);
    }
    if (small) {
        wpk_text(&wp, small, 98 * scale, (int)g.ph - 112 * scale,
                 "Wayland on a wasm32 POSIX kernel", WPK_RGB(0x36, 0x40, 0x58));
        wpk_text(&wp, small, 98 * scale, (int)g.ph - 84 * scale,
                 "click to focus - drag title bars to move windows",
                 WPK_RGB(0x2e, 0x37, 0x4c));
        wpk_font_destroy(small);
    }
    printf("WALLPAPER gradient\n");
    fflush(stdout);
}

/* Allocate the background once the mode is known, then paint it. */
static int setup_wallpaper(void) {
    g.wallpaper = malloc((size_t)g.pw * g.ph * 4);
    if (!g.wallpaper) return -1;
    render_wallpaper();
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

/* Advance a JSON reply's running length by an snprintf-style result
 * without ever passing the buffer. snprintf returns the length it WANTED to
 * write; adding that to the offset let the next `cap - n` underflow into a
 * huge size and write past the reply buffer. */
static int jclamp(int n, size_t cap) {
    if (n < 0) return 0;
    if (cap == 0) return 0;
    return (size_t)n >= cap ? (int)(cap - 1) : n;
}

/* Copy `src` as JSON string content: quote, backslash, and control bytes
 * escaped. Titles are client-controlled text. */
static const char *json_escape(char *dst, size_t cap, const char *src) {
    size_t n = 0;
    for (; *src && n + 7 < cap; src++) {
        unsigned char ch = (unsigned char)*src;
        if (ch == '"' || ch == '\\') {
            dst[n++] = '\\';
            dst[n++] = (char)ch;
        } else if (ch < 0x20) {
            n += (size_t)snprintf(dst + n, cap - n, "\\u%04x", ch);
        } else {
            dst[n++] = (char)ch;
        }
    }
    dst[n] = '\0';
    return dst;
}

/* JSON describing one surface, Hyprland `hyprctl clients -j`-shaped. The
 * fields beyond the original subset carry the keys Waybar's hyprland
 * modules read; extra keys are ignored by kbar's strstr parser. */
static int kwlctl_window_json(char *buf, size_t cap, struct surface *s) {
    char klass[64], title[192];
    json_escape(klass, sizeof(klass), s->app_id);
    json_escape(title, sizeof(title), s->title);
    /* Tag names are config words; escape them anyway, they are JSON strings. */
    char tags[MAX_TAGS * 72] = "";
    size_t tn = 0;
    for (int i = 0; i < n_tags; i++) {
        if (!(s->tags & (1u << i))) continue;
        char esc[72];
        json_escape(esc, sizeof(esc), tag_names[i]);
        tn += (size_t)snprintf(tags + tn, sizeof(tags) - tn, "%s\"%s\"",
                               tn ? "," : "", esc);
    }
    return snprintf(buf, cap,
        "{\"address\":\"%p\",\"class\":\"%s\",\"title\":\"%s\","
        "\"initialClass\":\"%s\",\"initialTitle\":\"%s\","
        "\"workspace\":{\"id\":%d,\"name\":\"%d\"},"
        "\"at\":[%d,%d],\"size\":[%d,%d],\"focused\":%s,"
        "\"mapped\":true,\"hidden\":false,\"floating\":%s,\"monitor\":0,"
        "\"pid\":-1,\"xwayland\":false,\"fullscreen\":false,"
        "\"grouped\":[],\"swallowing\":\"0x0\",\"tags\":[%s]}",
        (void *)s, klass, title, klass, title,
        s->workspace, s->workspace, s->x, s->y, s->w, s->h,
        g.kbd_focus == s ? "true" : "false",
        g.layout == LAYOUT_FLOATING ? "true" : "false", tags);
}

static int kwlctl_clients_json(char *buf, size_t cap) {
    int n = jclamp(snprintf(buf, cap, "["), cap);
    int first = 1;
    for (int i = 0; i < g.n_surfaces && n < (int)cap; i++) {
        struct surface *s = g.zorder[i];
        if (!s->mapped) continue;
        if (!first) n = jclamp(n + snprintf(buf + n, cap - n, ","), cap);
        n = jclamp(n + kwlctl_window_json(buf + n, cap - n, s), cap);
        first = 0;
    }
    n = jclamp(n + snprintf(buf + n, cap - n, "]\n"), cap);
    return n;
}

/* One workspace, Hyprland-shaped; `windows` and `active` predate the shape
 * and stay for kbar. Workspace names are their ids, and everything sits on
 * the single output. */
static int kwlctl_workspace_json(char *buf, size_t cap, int ws, int windows) {
    return snprintf(buf, cap,
        "{\"id\":%d,\"name\":\"%d\",\"monitor\":\"virtual-0\","
        "\"monitorID\":0,\"windows\":%d,\"hasfullscreen\":false,"
        "\"lastwindow\":\"0x0\",\"lastwindowtitle\":\"\",\"active\":%s}",
        ws, ws, windows, ws == g.active_ws ? "true" : "false");
}

static void workspace_counts(int counts[N_WORKSPACES + 1]) {
    memset(counts, 0, (N_WORKSPACES + 1) * sizeof(int));
    for (int i = 0; i < g.n_surfaces; i++)
        if (g.zorder[i]->mapped) counts[g.zorder[i]->workspace]++;
}

static int kwlctl_workspaces_json(char *buf, size_t cap) {
    int counts[N_WORKSPACES + 1];
    workspace_counts(counts);
    int n = jclamp(snprintf(buf, cap, "["), cap);
    int first = 1;
    for (int ws = 1; ws <= N_WORKSPACES && n < (int)cap; ws++) {
        if (!counts[ws] && ws != g.active_ws) continue;
        if (!first) n = jclamp(n + snprintf(buf + n, cap - n, ","), cap);
        n = jclamp(n + kwlctl_workspace_json(buf + n, cap - n, ws, counts[ws]), cap);
        first = 0;
    }
    n = jclamp(n + snprintf(buf + n, cap - n, "]\n"), cap);
    return n;
}

static int kwlctl_activeworkspace_json(char *buf, size_t cap) {
    int counts[N_WORKSPACES + 1];
    workspace_counts(counts);
    int n = jclamp(kwlctl_workspace_json(buf, cap, g.active_ws,
                                         counts[g.active_ws]), cap);
    n = jclamp(n + snprintf(buf + n, cap - n, "\n"), cap);
    return n;
}

static int kwlctl_monitors_json(char *buf, size_t cap) {
    return jclamp(snprintf(buf, cap,
        "[{\"id\":0,\"name\":\"virtual-0\",\"description\":\"Kandelo virtual "
        "output\",\"width\":%u,\"height\":%u,\"x\":0,\"y\":0,"
        "\"activeWorkspace\":{\"id\":%d,\"name\":\"%d\"},"
        "\"specialWorkspace\":{\"id\":0,\"name\":\"\"},"
        "\"scale\":1.00,\"focused\":true}]\n",
        g.width, g.height, g.active_ws, g.active_ws), cap);
}

/* The live theme + what is installed, so a shell client that starts after a
 * switch can pick up the current palette without watching the event stream. */
static int kwlctl_theme_json(char *buf, size_t cap) {
    int n = jclamp(snprintf(buf, cap, "{\"name\":\"%s\",\"themes\":[", th.name), cap);
    for (int i = 0; i < th.n_installed && n < (int)cap; i++)
        n = jclamp(n + snprintf(buf + n, cap - n, "%s\"%s\"", i ? "," : "",
                      th.installed[i]), cap);
    n = jclamp(n + snprintf(buf + n, cap - n, "]}\n"), cap);
    return n;
}

static int kwlctl_activewindow_json(char *buf, size_t cap) {
    if (!g.kbd_focus) return jclamp(snprintf(buf, cap, "{}\n"), cap);
    int n = jclamp(kwlctl_window_json(buf, cap, g.kbd_focus), cap);
    n = jclamp(n + snprintf(buf + n, cap - n, "\n"), cap);
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
        /* A failed launch is reported on stdout too: a keybind or launcher
         * entry pointing at a missing binary is otherwise a silent no-op. */
        fprintf(stderr, "posix_spawnp %s: %s\n", argv[0], strerror(rc));
        printf("KWLCTL_EXEC_FAILED \"%s\" err=%d\n", argv[0], rc);
        fflush(stdout);
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
    /* hyprctl's JSON marker: the reply is JSON either way, so `j/workspaces`
     * and `workspaces` answer identically. */
    if (strncmp(line, "j/", 2) == 0) line += 2;
    /* Sized from the live window count: each window's JSON is bounded by its
     * escaped, truncated class and title, and there is no window cap, so a
     * fixed buffer would truncate (the builders clamp, they never overrun). */
    static char *reply;
    static size_t reply_cap;
    size_t need = 16384 + (size_t)g.n_surfaces * 1024;
    if (need > reply_cap) {
        char *grown = realloc(reply, need);
        if (!grown) {
            kwlctl_send(c->fd, "error: out of memory\n", 21);
            return 0;
        }
        reply = grown;
        reply_cap = need;
    }
    char *buf = reply;
    const size_t bufcap = reply_cap;
    if (strcmp(line, "clients") == 0) {
        kwlctl_send(c->fd, buf, kwlctl_clients_json(buf, bufcap));
        return 0;
    }
    if (strcmp(line, "workspaces") == 0) {
        kwlctl_send(c->fd, buf, kwlctl_workspaces_json(buf, bufcap));
        return 0;
    }
    if (strcmp(line, "activeworkspace") == 0) {
        kwlctl_send(c->fd, buf, kwlctl_activeworkspace_json(buf, bufcap));
        return 0;
    }
    if (strcmp(line, "monitors") == 0) {
        kwlctl_send(c->fd, buf, kwlctl_monitors_json(buf, bufcap));
        return 0;
    }
    if (strcmp(line, "workspacerules") == 0) {
        kwlctl_send(c->fd, "[]\n", 3);
        return 0;
    }
    if (strcmp(line, "activewindow") == 0) {
        kwlctl_send(c->fd, buf, kwlctl_activewindow_json(buf, bufcap));
        return 0;
    }
    if (strcmp(line, "theme") == 0) {
        kwlctl_send(c->fd, buf, kwlctl_theme_json(buf, bufcap));
        return 0;
    }
    if (strncmp(line, "dispatch ", 9) == 0) {
        char *op = line + 9;
        if (strncmp(op, "workspace ", 10) == 0)
            switch_workspace(atoi(op + 10));
        else if (strncmp(op, "focusworkspaceoncurrentmonitor ", 31) == 0)
            switch_workspace(atoi(op + 31));
        else if (strncmp(op, "movetoworkspace ", 16) == 0)
            move_focus_to_workspace(atoi(op + 16));
        else if (strcmp(op, "close") == 0) {
            if (g.kbd_focus && g.kbd_focus->xdg_toplevel)
                xdg_toplevel_send_close(g.kbd_focus->xdg_toplevel);
        } else if (strncmp(op, "exec ", 5) == 0)
            kwlctl_exec(op + 5);
        else if (strncmp(op, "sendshortcut ", 13) == 0 ||
                 strncmp(op, DISP_SENDSHORTCUT_IF_TAG " ",
                         sizeof(DISP_SENDSHORTCUT_IF_TAG)) == 0) {
            int iftag = strncmp(op, "sendshortcut ", 13) != 0;
            struct keybind b = {0};
            if (parse_shortcut_args(iftag ? ACT_SEND_SHORTCUT_IF_TAG
                                          : ACT_SEND_SHORTCUT,
                                    op + (iftag ? sizeof(DISP_SENDSHORTCUT_IF_TAG)
                                                : 13), &b) < 0) {
                kwlctl_send(c->fd, "err malformed shortcut\n", 23);
                return 0;
            }
            b.action = iftag ? ACT_SEND_SHORTCUT_IF_TAG : ACT_SEND_SHORTCUT;
            run_dispatch(&b);
        }
        else if (strncmp(op, "theme ", 6) == 0) {
            if (theme_switch(op + 6) != 0) {
                kwlctl_send(c->fd, "err no such theme\n", 18);
                return 0;
            }
        } else {
            kwlctl_send(c->fd, "err unknown dispatch\n", 21);
            return 0;
        }
        kwlctl_send(c->fd, "ok\n", 3);
        return 0;
    }
    if (strcmp(line, "--listen") == 0) {
        if (c->listening) return 1;   /* a socket2 conn already streams */
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

/* A socket2 client gets the event stream from its first byte on; there is
 * no handshake line to send. */
static int hypr_socket2_readable(int fd, uint32_t mask, void *data) {
    (void)mask; (void)data;
    int cfd = accept(fd, NULL, NULL);
    if (cfd < 0) return 0;
    fcntl(cfd, F_SETFD, FD_CLOEXEC);
    struct kwlctl_conn *c = calloc(1, sizeof(*c));
    if (!c) { close(cfd); return 0; }
    c->fd = cfd;
    c->src = wl_event_loop_add_fd(g.loop, cfd, WL_EVENT_READABLE,
                                  kwlctl_conn_readable, c);
    for (int i = 0; i < MAX_KWLCTL_CONNS; i++)
        if (!g.listeners[i]) {
            g.listeners[i] = c;
            c->listening = 1;
            printf("HYPR_LISTENER slot=%d\n", i);
            fflush(stdout);
            return 0;
        }
    kwlctl_conn_close(c);
    return 0;
}

static int bind_control_socket(const char *path,
                               wl_event_loop_fd_func_t on_readable) {
    unlink(path);
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) { perror("socket ctl"); return -1; }
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("bind ctl"); close(fd); return -1;
    }
    if (listen(fd, 8) < 0) { perror("listen ctl"); close(fd); return -1; }
    wl_event_loop_add_fd(g.loop, fd, WL_EVENT_READABLE, on_readable, NULL);
    return 0;
}

static int setup_kwlctl(void) {
    if (bind_control_socket(KWLCTL_SOCKET_PATH, kwlctl_listen_readable) < 0)
        return -1;
    mkdir("/tmp/hypr", 0777);
    mkdir(HYPR_DIR, 0777);
    if (bind_control_socket(HYPR_SOCKET1_PATH, kwlctl_listen_readable) < 0)
        return -1;
    return bind_control_socket(HYPR_SOCKET2_PATH, hypr_socket2_readable);
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
    wl_list_init(&g.keyboards);
    wl_list_init(&g.pointers);
    wl_list_init(&g.outputs);
    wl_list_init(&sel.devices);
    wl_list_init(&sel.control_devices);
    wl_list_init(&g.shortcuts);
    wl_list_init(&g.idle_notifications);
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

    /* The mode is in device pixels, so it cannot tell a dpr-2 display from a
     * dpr-1 one — a 2176x1226 mode is either. WLC_SCALE sets the scale
     * explicitly; without it, setup_drm derives it from the connector's
     * physical size (the display's DPI), as Hyprland's `auto` scale does. */
    g.scale = 1;
    const char *want_scale = getenv("WLC_SCALE");
    if (want_scale) {
        long v = strtol(want_scale, NULL, 10);
        if (v >= 1 && v <= MAX_OUTPUT_SCALE) {
            g.scale = (uint32_t)v;
            g.scale_explicit = 1;
        } else {
            fprintf(stderr, "wlcompositor: ignoring WLC_SCALE=%s\n", want_scale);
        }
    }
    theme_scan();
    load_config();

    if (setup_drm() != 0) return 1;
    /* No layer surface has claimed anything yet, so the window work area is
     * the whole output. */
    g.usable = (struct geom){ 0, 0, (int)g.width, (int)g.height };
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
        !wl_global_create(g.display, &xdg_wm_base_interface, 2, NULL,
                          wm_base_bind) ||
        !wl_global_create(g.display, &zxdg_decoration_manager_v1_interface, 1,
                          NULL, decoration_mgr_bind) ||
        !wl_global_create(g.display, &zwlr_layer_shell_v1_interface, 4, NULL,
                          layer_shell_bind) ||
        !wl_global_create(g.display, &wp_presentation_interface, 1, NULL,
                          presentation_bind) ||
        !wl_global_create(g.display, &wl_subcompositor_interface, 1, NULL,
                          subcompositor_bind) ||
        !wl_global_create(g.display, &zxdg_output_manager_v1_interface, 3,
                          NULL, xdg_output_mgr_bind) ||
        !wl_global_create(g.display, &wp_viewporter_interface, 1, NULL,
                          viewporter_bind) ||
        !wl_global_create(g.display, &wp_fractional_scale_manager_v1_interface,
                          1, NULL, fractional_scale_mgr_bind) ||
        !wl_global_create(g.display, &wl_data_device_manager_interface, 3,
                          NULL, data_dm_bind) ||
        /* v2, as wlroots advertises it. The primary selection v2 adds is not
         * implemented, and its requests are ignored as the protocol allows. */
        !wl_global_create(g.display, &zwlr_data_control_manager_v1_interface, 2,
                          NULL, control_mgr_bind) ||
        !wl_global_create(g.display, &ext_data_control_manager_v1_interface, 1,
                          NULL, ext_control_mgr_bind) ||
        !wl_global_create(g.display, &ext_session_lock_manager_v1_interface, 1,
                          NULL, lock_mgr_bind) ||
        !wl_global_create(g.display, &ext_idle_notifier_v1_interface, 2, NULL,
                          idle_notifier_bind) ||
        !wl_global_create(g.display, &hyprland_global_shortcuts_manager_v1_interface,
                          1, NULL, shortcuts_mgr_bind) ||
        !wl_global_create(g.display, &wl_seat_interface, 5, NULL, seat_bind) ||
        !wl_global_create(g.display, &wl_output_interface, 4, NULL,
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
    /* A control client is free to fire a command and exit without reading the
     * reply — klauncher does exactly that when it launches an entry. Writing
     * that reply into the closed socket must not take the desktop down with
     * it; kwlctl_send already handles the short write. */
    signal(SIGPIPE, SIG_IGN);
    /* Children spawned via dispatch exec (Waybar among them) locate the
     * Hyprland IPC sockets through this pair. */
    setenv("HYPRLAND_INSTANCE_SIGNATURE", HYPR_INSTANCE_SIG, 1);
    setenv("XDG_RUNTIME_DIR", "/tmp", 0);
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
