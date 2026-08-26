/* libkwl — a tiny Wayland toolkit for Kandelo apps.
 *
 * Generalizes the ~300 lines of libwayland-client boilerplate in
 * programs/wlcompositor/wlclient-test.c (registry bind, xdg toplevel,
 * double-buffered wl_shm over gbm prime-fds, seat listeners, frame
 * callback, xkb keymap compile) into a small API: create one client-side
 * decorated (CSD) toplevel, draw into its back buffer with libwpkdraw,
 * commit, and pump input events. See
 * docs/plans/2026-07-09-dri-pr7-libkwl-wlterm-plan.md §4.
 *
 * Scope: a single toplevel per connection, software rendering into a wl_shm
 * buffer the compositor imports via gbm, keyboard (keysym + UTF-8) and
 * pointer (motion + button) input.
 *
 * Decoration follows the compositor's zxdg_decoration negotiation. When it
 * grants CLIENT_SIDE (the floating desktop) libkwl draws its own
 * KWL_TITLEBAR_H-px titlebar — title text + close box — above the content;
 * pressing the close box emits KWL_CLOSE and dragging the titlebar hands the
 * interaction to the compositor via xdg_toplevel.move. When it grants
 * SERVER_SIDE (a tiling WM) libkwl drops the titlebar entirely: the whole
 * surface is content and the compositor draws the border/focus ring.
 *
 * Resize: a tiling compositor dictates each window's geometry through the
 * xdg configure path. libkwl reallocates its buffers to the new size and
 * delivers a KWL_RESIZE event carrying the new content dimensions; the app
 * re-lays-out and redraws. A floating compositor sends a 0×0 "you decide"
 * configure, so a floating window keeps the size it asked for and never
 * sees KWL_RESIZE.
 */
#ifndef KWL_H
#define KWL_H

#include <stdint.h>
#include <wpkdraw/wpkdraw.h>

/* Opaque connection + toplevel window handle. */
struct kwl_window;

/* Height of the client-side decoration bar libkwl adds above the content.
 * The wl_surface the compositor sees is (w × h + KWL_TITLEBAR_H). */
#define KWL_TITLEBAR_H 28

enum kwl_event_type {
    KWL_NONE = 0,
    KWL_KEY,             /* a raw key transition (keysym + state) */
    KWL_TEXT,            /* a committed UTF-8 character (press only) */
    KWL_POINTER_MOTION,  /* pointer moved to (x, y) */
    KWL_POINTER_BUTTON,  /* pointer button transition at (x, y) */
    KWL_CLOSE,           /* the toplevel was asked to close */
    KWL_FRAME,           /* a committed frame was presented */
    KWL_RESIZE,          /* content size changed to (x, y) — realloc'd buffer */
};

/* Modifier bitmask for kwl_event.mods (effective state at the event). */
#define KWL_MOD_SHIFT 1u
#define KWL_MOD_CTRL  2u
#define KWL_MOD_ALT   4u

struct kwl_event {
    enum kwl_event_type type;
    uint32_t keysym;   /* KWL_KEY: an XKB keysym */
    uint32_t mods;     /* KWL_KEY/KWL_TEXT: KWL_MOD_* bitmask */
    uint32_t button;   /* KWL_POINTER_BUTTON: a linux BTN_* code */
    uint32_t state;    /* KWL_KEY/KWL_POINTER_BUTTON: 1 = down, 0 = up */
    int x, y;          /* KWL_POINTER_*: pointer pos; KWL_RESIZE: new w, h */
    char utf8[8];      /* KWL_TEXT: NUL-terminated UTF-8 */
};

/* Connect to the compositor (/tmp/wayland-0) and map a toplevel with a w×h
 * CONTENT area (the surface is taller by the titlebar the compositor grants,
 * 0 under server-side decoration). `title` is drawn in the titlebar and
 * doubles as the xdg app_id, which the compositor's placement rules key on.
 * Blocks until the initial xdg configure is acked and the wl_shm buffers are
 * ready. A tiling compositor may then resize the window (KWL_RESIZE). Returns
 * NULL on failure. */
struct kwl_window *kwl_window_create(const char *title, int w, int h);

void kwl_window_destroy(struct kwl_window *win);

/* The window's current back buffer as a wpk_surface. The returned pointer
 * is STABLE for the window's lifetime; its .pixels/.stride are re-pointed
 * at the new back buffer on each kwl_window_commit, so re-read it (or just
 * keep the pointer) after every commit. Draw into it with libwpkdraw. */
struct wpk_surface *kwl_window_surface(struct kwl_window *win);

/* Present the back buffer: attach + damage + request a frame callback +
 * commit, then swap to the other buffer for the next frame. A KWL_FRAME
 * event is delivered once the compositor presents the committed frame. */
void kwl_window_commit(struct kwl_window *win);

/* Pump the display and return the next input/frame event.
 *   timeout_ms < 0 : block until an event is available.
 *   timeout_ms = 0 : non-blocking drain (for an external epoll loop).
 *   timeout_ms > 0 : block up to timeout_ms.
 * Returns 1 and fills *out when an event is produced, else 0. */
int kwl_dispatch(struct kwl_window *win, struct kwl_event *out, int timeout_ms);

/* The wl_display connection fd. LOAD-BEARING: wlterm polls this alongside
 * the PTY master, then drains events with kwl_dispatch(.,.,0). */
int kwl_display_fd(struct kwl_window *win);

#endif /* KWL_H */
