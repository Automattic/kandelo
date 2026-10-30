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
 *   - Each buffer owns a render descriptor independent of EGL's sessions.
 *     EGL transfers its per-fd BO name into the surface session through
 *     PRIME. The native window can outlive an EGL generation without
 *     retaining a stale descriptor or revoking another owner's GEM names.
 *   - SINGLE reusable buffer (one bo / one wl_buffer, re-attached every frame).
 *     The GPU-tier bo is a persistent host WebGLTexture+FBO and the compositor
 *     re-binds the foreign texture per commit; the one shared GL submit queue
 *     orders render-before-sample, so no buffer pool / wl_buffer.release
 *     tracking is needed in v1.
 *   - Resize swaps that single buffer: wl_egl_window_resize allocates a bo at
 *     the new size and has libEGL re-aim the live window surface at it
 *     (_wpk_egl_window_retarget), so the next frame renders at the new size.
 *     A tiling compositor resizes every window it maps, and a GL client that
 *     kept its creation-size buffer drew its new viewport cropped into it.
 *     The old buffer is retired, not destroyed, until the new one has been
 *     attached and committed, so the compositor never loses the surface's
 *     current buffer.
 *   - The zwp_linux_dmabuf_v1 global is bound through a PRIVATE wl_event_queue
 *     so the roundtrip here never consumes events off the client's default
 *     queue (SDL dispatches that queue itself).
 *
 * The GPU path is browser-only (needs WebGL2). On a host without a shared GL
 * context gbm degrades the bo to a CPU dumb bo; the shim still wires a valid
 * dmabuf wl_buffer, but rendered content requires the GPU tier.
 */

#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <unistd.h>
#include <pthread.h>
#include <limits.h>
#include "wayland-native.h"

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
    struct wl_egl_window *window;
    const void *display;
    uint64_t display_identity;
    void *surface_hold;
    unsigned references;
    int owner_alive, resizing, active;
    pthread_t resize_thread;
    uint32_t width,height;
    struct wpk_wlegl *next;
    struct gbm_device            *gbm;
    struct gbm_bo                *bo;
    uint32_t bo_handle;                        /* per-fd handle on gbm's device */
    struct wl_event_queue        *queue;       /* private queue for the bind */
    struct zwp_linux_dmabuf_v1   *dmabuf;
    struct wl_buffer             *buffer;      /* the single reusable buffer */
    /* The buffer a resize replaced; destroyed once its successor has been
     * committed (see wl_egl_window_resize). */
    struct gbm_device            *retired_gbm;
    struct gbm_bo                *retired_bo;
    struct wl_buffer             *retired_buffer;
};

/* libEGL re-targets the live window surface at the window's current bo. */
__attribute__((weak)) int _wpk_egl_window_retarget(void *egl_window);

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
    if (wl_display_roundtrip_queue(dpy, queue) < 0) goto fail;
    if (b.dmabuf) {
        zwp_linux_dmabuf_v1_add_listener(b.dmabuf, &dmabuf_listener, &b);
        if (wl_display_roundtrip_queue(dpy, queue) < 0) goto fail;
    }
    wl_registry_destroy(reg);
    return b.dmabuf;
fail:
    if (b.dmabuf) zwp_linux_dmabuf_v1_destroy(b.dmabuf);
    wl_registry_destroy(reg);
    return NULL;
}

/* ---- buffer allocation -------------------------------------------------- */

/* Allocate the GPU-tier bo on the EGL fd and wrap it as a dmabuf wl_buffer.
 * On success fills w->bo/gbm/bo_handle/buffer and returns 0. */
static int alloc_buffer(struct wpk_wlegl *w, struct wl_egl_window *win,
                        int width, int height) {
    int fd = open(WPK_GL_DEVICE, O_RDWR | O_CLOEXEC);
    if (fd < 0)
        return -1;

    w->gbm = gbm_create_device(fd);
    if (!w->gbm) {
        close(fd);
        return -1;
    }

    /* GPU tier: RENDERING only (no CPU-facing usage) so gbm issues
     * WPK_CREATE_GPU_BO — a host WebGLTexture+FBO we render into and sample
     * zero-copy. Degrades to a CPU dumb bo on hosts without a shared GL ctx.
     * The format is XBGR8888 because that is what the bo holds: GL writes a
     * WebGL RGBA texture as [R,G,B,A] bytes, which DRM calls XBGR8888.
     * XRGB8888 would mean [B,G,R,X], and a compositor honouring it would
     * show the client with red and blue swapped. */
    w->bo = gbm_bo_create(w->gbm, (uint32_t)width, (uint32_t)height,
                          GBM_FORMAT_XBGR8888, GBM_BO_USE_RENDERING);
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
    /* Y_INVERT: GL renders into the bo's framebuffer, whose rows are stored
     * bottom-up, so the compositor must flip it when it samples the buffer
     * (Mesa's Wayland EGL platform renders flipped instead; the flag is the
     * protocol's way to say the same thing). */
    w->buffer = zwp_linux_buffer_params_v1_create_immed(
        params, width, height, DRM_FORMAT_XBGR8888,
        ZWP_LINUX_BUFFER_PARAMS_V1_FLAGS_Y_INVERT);
    zwp_linux_buffer_params_v1_destroy(params);
    close(prime);   /* the compositor dup'd it into its own bo */

    if(!w->buffer)return -1;
    w->width=(uint32_t)width;w->height=(uint32_t)height;return 0;
}

static void free_device(struct gbm_device *device) {
    int fd = gbm_device_get_fd(device);
    gbm_device_destroy(device);
    close(fd);
}

static void free_retired(struct wpk_wlegl *w) {
    if (w->retired_buffer) { wl_buffer_destroy(w->retired_buffer); w->retired_buffer = NULL; }
    if (w->retired_bo)     { gbm_bo_destroy(w->retired_bo); w->retired_bo = NULL; }
    if (w->retired_gbm) {
        free_device(w->retired_gbm);
        w->retired_gbm = NULL;
    }
}

static void free_buffer(struct wpk_wlegl *w) {
    free_retired(w);
    if (w->buffer) { wl_buffer_destroy(w->buffer); w->buffer = NULL; }
    if (w->bo)     { gbm_bo_destroy(w->bo); w->bo = NULL; }
    if (w->gbm) {
        free_device(w->gbm);
        w->gbm = NULL;
    }
    w->bo_handle = 0;
}

/* Native windows have independent public and EGL lease lifetimes. Only
 * list membership validates untrusted pointers; never inspect their memory. */
static pthread_mutex_t window_mutex=PTHREAD_MUTEX_INITIALIZER;
static struct wpk_wlegl *windows;
static struct wpk_wlegl *find_window(const void *native) {
    for(struct wpk_wlegl *w=windows;w;w=w->next)if(w->window==native && w->owner_alive)return w;
    return NULL;
}
static struct wpk_wlegl *readable_window(const void *native) {
    struct wpk_wlegl *w=find_window(native);
    return w && w->resizing && !pthread_equal(w->resize_thread,pthread_self()) ? NULL : w;
}
static struct wpk_wlegl *find_lease(void *lease) {
    for(struct wpk_wlegl *w=windows;w;w=w->next)if(w==lease && w->references)return w;
    return NULL;
}
static struct wpk_wlegl *collect_window(struct wpk_wlegl *w) {
    if(w->owner_alive || w->references || w->active || w->resizing)return NULL;
    struct wpk_wlegl **link=&windows;while(*link && *link!=w)link=&(*link)->next;
    if(*link)*link=w->next;
    return w;
}
static void free_window(struct wpk_wlegl *w) {
    if(!w)return;
    free_buffer(w);
    if(w->dmabuf)zwp_linux_dmabuf_v1_destroy(w->dmabuf);
    if(w->queue)wl_event_queue_destroy(w->queue);
    // The physical display and original proxy remain alive through all
    // native queue/buffer teardown, even after public disconnect/destroy.
    _wpk_wl_surface_release(w->surface_hold);
    free(w->window);free(w);
}
struct wl_egl_window *wl_egl_window_create(struct wl_surface *surface,int width,int height) {
    if(!surface || width<=0 || height<=0)return NULL;
    struct wl_egl_window *win=calloc(1,sizeof *win);
    struct wpk_wlegl *w=calloc(1,sizeof *w);
    if(!win || !w) {free(win);free(w);return NULL;}
    w->window=win;
    w->surface_hold=_wpk_wl_surface_acquire(surface,&w->display,&w->display_identity);
    if(!w->surface_hold) {free(win);free(w);return NULL;}
    struct wl_display *display=(struct wl_display *)w->display;
    w->queue=wl_display_create_queue(display);
    if(!w->queue) {free_window(w);return NULL;}
    w->dmabuf=bind_dmabuf(display,w->queue);
    if(!w->dmabuf || alloc_buffer(w,win,width,height)!=0) {free_window(w);return NULL;}
    *(intptr_t *)&win->version=WL_EGL_WINDOW_VERSION;
    win->width=win->attached_width=width;win->height=win->attached_height=height;
    win->surface=surface;win->driver_private=w;w->owner_alive=1;
    pthread_mutex_lock(&window_mutex);w->next=windows;windows=w;pthread_mutex_unlock(&window_mutex);
    return win;
}
void wl_egl_window_destroy(struct wl_egl_window *win) {
    pthread_mutex_lock(&window_mutex);
    struct wpk_wlegl *w=find_window(win),*retired=NULL;
    if(w) {w->owner_alive=0;retired=collect_window(w);}
    pthread_mutex_unlock(&window_mutex);free_window(retired);
}
static void copy_allocation(struct wpk_wlegl *to,const struct wpk_wlegl *from) {
    to->gbm=from->gbm;to->bo=from->bo;to->bo_handle=from->bo_handle;to->buffer=from->buffer;
    to->width=from->width;to->height=from->height;
}
void wl_egl_window_resize(struct wl_egl_window *win,int width,int height,int dx,int dy) {
    pthread_mutex_lock(&window_mutex);
    struct wpk_wlegl *w=find_window(win);
    if(!w || w->resizing || w->active || !_wpk_wl_surface_alive(w->surface_hold)) {
        pthread_mutex_unlock(&window_mutex);return;
    }
    if(width<=0)width=(int)w->width;if(height<=0)height=(int)w->height;
    if(width==(int)w->width && height==(int)w->height) {pthread_mutex_unlock(&window_mutex);return;}
    w->resizing=1;w->resize_thread=pthread_self();
    struct wpk_wlegl old={.gbm=w->gbm,.bo=w->bo,.buffer=w->buffer,.bo_handle=w->bo_handle,.width=w->width,.height=w->height};
    pthread_mutex_unlock(&window_mutex);
    // No window lock across the EGL callback: EGL always precedes native
    // window locking. Other resize/present admission refuses while this exact
    // resize owns its candidate; destruction retains it until we finish.
    free_retired(w);
    w->gbm=NULL;w->bo=NULL;w->buffer=NULL;w->bo_handle=0;
    int accepted=alloc_buffer(w,win,width,height)==0;
    if(accepted && _wpk_egl_window_retarget)accepted=_wpk_egl_window_retarget(win);
    if(!accepted) {free_buffer(w);copy_allocation(w,&old);}
    else {
        w->retired_gbm=old.gbm;w->retired_bo=old.bo;w->retired_buffer=old.buffer;
    }
    pthread_mutex_lock(&window_mutex);
    if(accepted) {win->width=win->attached_width=width;win->height=win->attached_height=height;win->dx=dx;win->dy=dy;}
    w->resizing=0;
    struct wpk_wlegl *retired=collect_window(w);pthread_mutex_unlock(&window_mutex);free_window(retired);
}
void wl_egl_window_get_attached_size(struct wl_egl_window *win,int *width,int *height) {
    pthread_mutex_lock(&window_mutex);struct wpk_wlegl *w=find_window(win);
    if(width)*width=w ? win->attached_width : 0;if(height)*height=w ? win->attached_height : 0;
    pthread_mutex_unlock(&window_mutex);
}
static int prepare_window(struct wpk_wlegl *w,struct wpk_wlegl_frame *frame) {
    if(!w || !w->owner_alive || w->active || (w->resizing && !pthread_equal(w->resize_thread,pthread_self()))
      || !_wpk_wl_surface_alive(w->surface_hold))return 0;
    w->active=1;
    *frame=(struct wpk_wlegl_frame){.fd=gbm_device_get_fd(w->gbm),.handle=w->bo_handle,.width=w->width,.height=w->height};
    return 1;
}
int _wpk_wlegl_acquire(const void *window,const void *display,uint64_t identity,void **lease,struct wpk_wlegl_frame *frame) {
    pthread_mutex_lock(&window_mutex);struct wpk_wlegl *w=find_window(window);
    int ok=w && (!display || (w->display==display && w->display_identity==identity))
        && w->references<UINT_MAX && prepare_window(w,frame);
    if(ok) {w->references++;*lease=w;}
    pthread_mutex_unlock(&window_mutex);return ok;
}
int _wpk_wlegl_prepare(void *lease,struct wpk_wlegl_frame *frame) {
    pthread_mutex_lock(&window_mutex);int ok=prepare_window(find_lease(lease),frame);
    pthread_mutex_unlock(&window_mutex);return ok;
}
int _wpk_wlegl_finish(void *lease,int present) {
    pthread_mutex_lock(&window_mutex);struct wpk_wlegl *w=find_lease(lease);
    int ok=w && w->active;
    if(ok && present) {
        ok=w->owner_alive && !w->resizing && _wpk_wl_surface_present(w->surface_hold,w->buffer,(int)w->width,(int)w->height);
        if(ok)free_retired(w);
    }
    if(w)w->active=0;
    pthread_mutex_unlock(&window_mutex);return ok;
}
void _wpk_wlegl_release(void *lease) {
    pthread_mutex_lock(&window_mutex);struct wpk_wlegl *w=find_lease(lease),*retired=NULL;
    if(w) {w->references--;retired=collect_window(w);}
    pthread_mutex_unlock(&window_mutex);free_window(retired);
}
/* Legacy metadata entry points stay safe for callers that only inspect a
 * live native window. EGL itself uses the retained typed lease above. */
uint32_t _wpk_wlegl_bo_handle(void *window) {
    pthread_mutex_lock(&window_mutex);struct wpk_wlegl *w=readable_window(window);
    uint32_t result=w ? w->bo_handle : 0;pthread_mutex_unlock(&window_mutex);return result;
}
int _wpk_wlegl_device_fd(void *window) {
    pthread_mutex_lock(&window_mutex);struct wpk_wlegl *w=readable_window(window);
    int result=w ? gbm_device_get_fd(w->gbm) : -1;pthread_mutex_unlock(&window_mutex);return result;
}
int _wpk_wlegl_dimensions(void *window,uint32_t *width,uint32_t *height) {
    pthread_mutex_lock(&window_mutex);struct wpk_wlegl *w=readable_window(window);
    if(w) {*width=w->width;*height=w->height;}pthread_mutex_unlock(&window_mutex);return w!=NULL;
}
void _wpk_wlegl_present(void *window) {
    void *lease=NULL;struct wpk_wlegl_frame frame;
    if(_wpk_wlegl_acquire(window,NULL,0,&lease,&frame)) {_wpk_wlegl_finish(lease,1);_wpk_wlegl_release(lease);}
}
