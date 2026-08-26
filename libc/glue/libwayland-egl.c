/*
 * libwayland-egl shim for wasm-posix-kernel (step 12a).
 *
 * SDL2's upstream Wayland+OpenGLES backend (and any mesa-style client) drives
 * a GL window through the standard libwayland-egl entry points:
 *
 *   wl_egl_window_create(surface, w, h)  -> struct wl_egl_window *
 *   eglCreateWindowSurface(dpy, cfg, (EGLNativeWindowType)egl_window)
 *   ... render GL ...
 *   eglSwapBuffers(dpy, egl_surface)     -> present
 *
 * On a real system libwayland-egl is a dumb struct holder and mesa's egl_dri2
 * Wayland platform owns the buffer/present logic. We have no mesa, so this one
 * translation unit merges both roles: it allocates the GPU-tier bo the window
 * renders into, wraps it as a zwp_linux_dmabuf_v1 wl_buffer, and — driven by
 * the two hooks libEGL calls (`_wpk_wlegl_bo_handle`, `_wpk_wlegl_present`) —
 * targets that bo's FBO at surface creation and attach+commits it on swap.
 *
 * Design decisions (see docs/plans/2026-07-08-dri-wayland-compositor-plan.md
 * §7.1 and the step-12 handoff):
 *   - The bo is created on the EGL session's OWN renderD128 fd (_wpk_gl_fd())
 *     so its per-fd handle is the one eglCreateWindowSurface can target
 *     (GLIO_CREATE_SURFACE.reserved[0]). gbm_device_destroy does not close the
 *     fd, so tearing a window down never disturbs the live EGL session.
 *   - SINGLE reusable buffer (one bo / one wl_buffer, re-attached every frame).
 *     The GPU-tier bo is a persistent host WebGLTexture+FBO and the compositor
 *     re-binds the foreign texture per commit; the one shared GL submit queue
 *     orders render-before-sample, so no buffer pool / wl_buffer.release
 *     tracking is needed in v1. Live resize is therefore not supported — the
 *     window keeps its creation size (documented below).
 *   - The zwp_linux_dmabuf_v1 global is bound through a PRIVATE wl_event_queue
 *     so the roundtrip here never consumes events off the client's default
 *     queue (SDL dispatches that queue itself).
 *
 * The GPU path is browser-only (needs WebGL2). On a host without a shared GL
 * context gbm degrades the bo to a CPU dumb bo; the shim still wires a valid
 * dmabuf wl_buffer, but rendered content requires the GPU tier.
 */

#include <stdint.h>
#include <stdlib.h>
#include <unistd.h>

#include <wayland-client.h>
#include <wayland-client-protocol.h>
#include "linux-dmabuf-v1-client-protocol.h"

#include <gbm.h>
#include <drm/drm_fourcc.h>

#include "wayland-egl-backend.h"
#include "gl_abi.h"

/* Per-window backend state, hung off wl_egl_window.driver_private (the mesa
 * contract). Both this file (producer) and libEGL (consumer, via the accessor
 * hooks below) reach it only through the accessors, never by layout. */
struct wpk_wlegl {
    struct gbm_device            *gbm;
    struct gbm_bo                *bo;
    uint32_t                      bo_handle;   /* per-fd handle on _wpk_gl_fd() */
    struct wl_event_queue        *queue;       /* private queue for the bind */
    struct zwp_linux_dmabuf_v1   *dmabuf;
    struct wl_buffer             *buffer;      /* the single reusable buffer */
};

/* ---- zwp_linux_dmabuf_v1 bind (private-queue registry roundtrip) --------- */

struct bind_state { struct zwp_linux_dmabuf_v1 *dmabuf; uint32_t version; };

static void dmabuf_format(void *d, struct zwp_linux_dmabuf_v1 *o, uint32_t f) {
    (void)d; (void)o; (void)f;
}
static void dmabuf_modifier(void *d, struct zwp_linux_dmabuf_v1 *o,
                            uint32_t f, uint32_t hi, uint32_t lo) {
    (void)d; (void)o; (void)f; (void)hi; (void)lo;
}
static const struct zwp_linux_dmabuf_v1_listener dmabuf_listener = {
    .format = dmabuf_format,
    .modifier = dmabuf_modifier,
};

static void reg_global(void *data, struct wl_registry *reg, uint32_t name,
                       const char *iface, uint32_t version) {
    struct bind_state *b = data;
    if (__builtin_strcmp(iface, "zwp_linux_dmabuf_v1") == 0) {
        uint32_t v = version < 3 ? version : 3;
        b->dmabuf = wl_registry_bind(reg, name, &zwp_linux_dmabuf_v1_interface, v);
        b->version = v;
    }
}
static void reg_global_remove(void *data, struct wl_registry *r, uint32_t n) {
    (void)data; (void)r; (void)n;
}
static const struct wl_registry_listener reg_listener = {
    .global = reg_global,
    .global_remove = reg_global_remove,
};

/* Bind zwp_linux_dmabuf_v1 on `dpy` using a private queue so we don't steal
 * events off the caller's default queue. Returns the bound proxy (already on
 * `queue`) or NULL. */
static struct zwp_linux_dmabuf_v1 *bind_dmabuf(struct wl_display *dpy,
                                               struct wl_event_queue *queue) {
    struct wl_registry *reg = wl_display_get_registry(dpy);
    if (!reg) return NULL;
    wl_proxy_set_queue((struct wl_proxy *)reg, queue);
    struct bind_state b = { .dmabuf = NULL, .version = 0 };
    wl_registry_add_listener(reg, &reg_listener, &b);
    /* Two roundtrips: the first delivers the global, the second drains the
     * format/modifier burst the compositor emits on bind (harmless to skip,
     * but keeps the private queue tidy). */
    if (wl_display_roundtrip_queue(dpy, queue) < 0) { wl_registry_destroy(reg); return NULL; }
    if (b.dmabuf) {
        zwp_linux_dmabuf_v1_add_listener(b.dmabuf, &dmabuf_listener, &b);
        wl_display_roundtrip_queue(dpy, queue);
    }
    wl_registry_destroy(reg);
    return b.dmabuf;
}

/* ---- buffer allocation -------------------------------------------------- */

/* Allocate the GPU-tier bo on the EGL fd and wrap it as a dmabuf wl_buffer.
 * On success fills w->bo/gbm/bo_handle/buffer and returns 0. */
static int alloc_buffer(struct wpk_wlegl *w, struct wl_egl_window *win,
                        int width, int height) {
    int fd = _wpk_gl_fd();
    if (fd < 0) return -1;   /* EGL not initialized yet — no session fd */

    w->gbm = gbm_create_device(fd);
    if (!w->gbm) return -1;

    /* GPU tier: RENDERING only (no CPU-facing usage) so gbm issues
     * WPK_CREATE_GPU_BO — a host WebGLTexture+FBO we render into and sample
     * zero-copy. Degrades to a CPU dumb bo on hosts without a shared GL ctx. */
    w->bo = gbm_bo_create(w->gbm, (uint32_t)width, (uint32_t)height,
                          GBM_FORMAT_XRGB8888, GBM_BO_USE_RENDERING);
    if (!w->bo) return -1;
    w->bo_handle = gbm_bo_get_handle(w->bo).u32;

    uint32_t stride = gbm_bo_get_stride(w->bo);
    int prime = gbm_bo_get_fd(w->bo);
    if (prime < 0) return -1;

    struct zwp_linux_buffer_params_v1 *params =
        zwp_linux_dmabuf_v1_create_params(w->dmabuf);
    zwp_linux_buffer_params_v1_add(
        params, prime, 0, 0, stride,
        (uint32_t)(DRM_FORMAT_MOD_LINEAR >> 32),
        (uint32_t)(DRM_FORMAT_MOD_LINEAR & 0xffffffffu));
    w->buffer = zwp_linux_buffer_params_v1_create_immed(
        params, width, height, DRM_FORMAT_XRGB8888, 0);
    zwp_linux_buffer_params_v1_destroy(params);
    close(prime);   /* the compositor dup'd it into its own bo */

    return w->buffer ? 0 : -1;
}

static void free_buffer(struct wpk_wlegl *w) {
    if (w->buffer) { wl_buffer_destroy(w->buffer); w->buffer = NULL; }
    if (w->bo)     { gbm_bo_destroy(w->bo); w->bo = NULL; }
    if (w->gbm)    { gbm_device_destroy(w->gbm); w->gbm = NULL; } /* no fd close */
    w->bo_handle = 0;
}

/* ---- public libwayland-egl API ------------------------------------------ */

struct wl_egl_window *
wl_egl_window_create(struct wl_surface *surface, int width, int height) {
    if (!surface || width <= 0 || height <= 0) return NULL;

    struct wl_egl_window *win = calloc(1, sizeof(*win));
    struct wpk_wlegl     *w   = calloc(1, sizeof(*w));
    if (!win || !w) { free(win); free(w); return NULL; }

    struct wl_display *dpy = wl_proxy_get_display((struct wl_proxy *)surface);
    if (!dpy) { free(win); free(w); return NULL; }
    w->queue = wl_display_create_queue(dpy);
    if (!w->queue) { free(win); free(w); return NULL; }

    w->dmabuf = bind_dmabuf(dpy, w->queue);
    if (!w->dmabuf || alloc_buffer(w, win, width, height) != 0) {
        free_buffer(w);
        if (w->dmabuf) zwp_linux_dmabuf_v1_destroy(w->dmabuf);
        wl_event_queue_destroy(w->queue);
        free(win); free(w);
        return NULL;
    }

    /* Fill the canonical backend struct. `version` is a const field, so cast
     * through the address to initialise it once at construction. */
    *(intptr_t *)&win->version = WL_EGL_WINDOW_VERSION;
    win->width = width;
    win->height = height;
    win->dx = win->dy = 0;
    win->attached_width = width;
    win->attached_height = height;
    win->surface = surface;
    win->driver_private = w;
    win->resize_callback = NULL;
    win->destroy_window_callback = NULL;
    return win;
}

void wl_egl_window_destroy(struct wl_egl_window *win) {
    if (!win) return;
    struct wpk_wlegl *w = win->driver_private;
    if (w) {
        free_buffer(w);
        if (w->dmabuf) zwp_linux_dmabuf_v1_destroy(w->dmabuf);
        if (w->queue)  wl_event_queue_destroy(w->queue);
        free(w);
    }
    free(win);
}

/* v1 keeps the creation size: the GL surface's FBO target is bound to the
 * bo at eglCreateWindowSurface time and there's no path to re-target a live
 * EGL surface, so a genuine resize would desync render size from the buffer.
 * We record the request (SDL reads it back) but do not reallocate. */
void wl_egl_window_resize(struct wl_egl_window *win, int width, int height,
                          int dx, int dy) {
    if (!win) return;
    win->dx = dx;
    win->dy = dy;
    if (width > 0)  win->width = width;
    if (height > 0) win->height = height;
}

void wl_egl_window_get_attached_size(struct wl_egl_window *win,
                                     int *width, int *height) {
    if (!win) { if (width) *width = 0; if (height) *height = 0; return; }
    if (width)  *width  = win->attached_width;
    if (height) *height = win->attached_height;
}

/* ---- hooks called by libEGL (libegl_stub.c) ----------------------------- */

/* Return the GPU-tier bo handle an eglCreateWindowSurface should target for
 * this native window, or 0 if it isn't one of ours. */
uint32_t _wpk_wlegl_bo_handle(void *egl_window) {
    if (!egl_window) return 0;
    struct wl_egl_window *win = egl_window;
    struct wpk_wlegl *w = win->driver_private;
    return w ? w->bo_handle : 0;
}

/* Present: attach the (already-rendered, already-flushed) buffer to the
 * surface and commit. libEGL's eglSwapBuffers has issued the GL flush +
 * GLIO_PRESENT fence before calling this, so the frame is complete on the
 * shared context by the time the compositor samples it. */
void _wpk_wlegl_present(void *egl_window) {
    struct wl_egl_window *win = egl_window;
    struct wpk_wlegl *w = win ? win->driver_private : NULL;
    if (!egl_window) return;
    if (!w || !w->buffer || !win->surface) return;
    wl_surface_attach(win->surface, w->buffer, 0, 0);
    wl_surface_damage(win->surface, 0, 0, win->width, win->height);
    wl_surface_commit(win->surface);
}
