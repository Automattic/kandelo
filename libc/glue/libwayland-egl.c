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
 * The native window owns a private GPU render back and the existing bounded
 * GBM front ring. EGL copies the back into a top-row-first front before
 * publishing it. A front remains locked until its wl_buffer.release event;
 * the compositor never observes a buffer that the client is still drawing.
 * Resize retains the preceding allocation until its successor is committed.
 * Protocol discovery and release backpressure use a private event queue, so
 * SDL and other clients retain ownership of their default event queue.
 */

#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <unistd.h>
#include <pthread.h>
#include <limits.h>
#include <errno.h>
#include "gbm_window.h"
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
struct wpk_allocation;
struct wpk_front {
    struct wpk_allocation *allocation;
    struct gbm_bo *bo;
    struct wl_buffer *buffer;
    int busy;
};
struct wpk_allocation {
    struct gbm_device *gbm;
    struct gbm_surface *surface;
    void *lease;
    struct wpk_gbm_frame back;
    struct wpk_front fronts[4];
};
struct wpk_wlegl {
    struct wl_egl_window *window;
    const void *display;
    uint64_t display_identity;
    void *surface_hold;
    unsigned references;
    int owner_alive, resizing, active, presenting;
    pthread_t resize_thread;
    uint32_t width,height;
    struct wpk_wlegl *next;
    struct wl_event_queue *queue;
    struct zwp_linux_dmabuf_v1 *dmabuf;
    struct wpk_allocation *allocation, *retired;
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

static void front_release(void *data,struct wl_buffer *buffer) {
    struct wpk_front *front=data;
    if(front->buffer==buffer && front->busy) {
        front->busy=0;
        gbm_surface_release_buffer(front->allocation->surface,front->bo);
    }
}
static const struct wl_buffer_listener buffer_listener={.release=front_release};

/* Each listener points into a stable allocation capsule, including across
 * resize. A proxy is created only for a real reserved GBM front, never back. */
static struct wpk_front *wrap_front(struct wpk_wlegl *w,struct wpk_allocation *a,struct gbm_bo *bo) {
    struct wpk_front *front=NULL;
    for(unsigned i=0;i<4;i++) {
        if(a->fronts[i].bo==bo)return &a->fronts[i];
        if(!a->fronts[i].bo && !front)front=&a->fronts[i];
    }
    if(!front)return NULL;
    int prime=gbm_bo_get_fd(bo);
    if(prime<0)return NULL;
    struct zwp_linux_buffer_params_v1 *params=zwp_linux_dmabuf_v1_create_params(w->dmabuf);
    if(!params) {close(prime);return NULL;}
    zwp_linux_buffer_params_v1_add(params,prime,0,0,gbm_bo_get_stride(bo),
        (uint32_t)(DRM_FORMAT_MOD_LINEAR>>32),(uint32_t)DRM_FORMAT_MOD_LINEAR);
    /* The GLIO front copy normalizes row order. Ordinary linux-dmabuf clients
     * must not require Y_INVERT (wlroots 0.20 rejects nonzero flags). */
    struct wl_buffer *buffer=zwp_linux_buffer_params_v1_create_immed(params,
        (int)a->back.width,(int)a->back.height,DRM_FORMAT_XBGR8888,0);
    zwp_linux_buffer_params_v1_destroy(params);close(prime);
    if(!buffer)return NULL;
    wl_proxy_set_queue((struct wl_proxy *)buffer,w->queue);
    *front=(struct wpk_front){.allocation=a,.bo=bo,.buffer=buffer};
    if(wl_buffer_add_listener(buffer,&buffer_listener,front)<0) {
        wl_buffer_destroy(buffer);*front=(struct wpk_front){0};return NULL;
    }
    return front;
}
static void free_allocation(struct wpk_allocation *a) {
    if(!a)return;
    for(unsigned i=0;i<4;i++) {
        struct wpk_front *front=&a->fronts[i];
        if(front->buffer)wl_buffer_destroy(front->buffer);
        if(front->busy)gbm_surface_release_buffer(a->surface,front->bo);
    }
    if(a->lease)_wpk_gbm_window_release(a->lease);
    if(a->surface)gbm_surface_destroy(a->surface);
    if(a->gbm) {
        int fd=gbm_device_get_fd(a->gbm);gbm_device_destroy(a->gbm);close(fd);
    }
    free(a);
}
static int alloc_buffer(struct wpk_wlegl *w,int width,int height) {
    struct wpk_allocation *a=calloc(1,sizeof *a);
    if(!a)return -1;
    int fd=open(WPK_GL_DEVICE,O_RDWR|O_CLOEXEC);
    if(fd<0) {free(a);return -1;}
    a->gbm=gbm_create_device(fd);
    if(!a->gbm) {close(fd);free(a);return -1;}
    a->surface=gbm_surface_create(a->gbm,(uint32_t)width,(uint32_t)height,
        GBM_FORMAT_XBGR8888,GBM_BO_USE_RENDERING);
    if(!a->surface || !_wpk_gbm_window_acquire(a->surface,&a->lease,&a->back))goto fail;
    /* Allocate and validate the first protocol proxy before publication.
     * It is not attached until EGL has copied a complete rendered frame. */
    struct wpk_gbm_frame initial;
    if(!_wpk_gbm_window_prepare(a->lease,&initial))goto fail;
    _wpk_gbm_window_finish(a->lease,1);
    struct gbm_bo *bo=gbm_surface_lock_front_buffer(a->surface);
    if(!bo)goto fail;
    struct wpk_front *front=wrap_front(w,a,bo);
    gbm_surface_release_buffer(a->surface,bo);
    if(!front)goto fail;
    w->allocation=a;w->width=(uint32_t)width;w->height=(uint32_t)height;return 0;
fail:
    free_allocation(a);return -1;
}
static void free_retired(struct wpk_wlegl *w) {
    struct wpk_allocation *a=w->retired;w->retired=NULL;free_allocation(a);
}
static void free_buffer(struct wpk_wlegl *w) {
    free_retired(w);free_allocation(w->allocation);w->allocation=NULL;
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
    if(!w->dmabuf || alloc_buffer(w,width,height)!=0) {free_window(w);return NULL;}
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
void wl_egl_window_resize(struct wl_egl_window *win,int width,int height,int dx,int dy) {
    pthread_mutex_lock(&window_mutex);
    struct wpk_wlegl *w=find_window(win);
    if(!w || w->resizing || w->active || !_wpk_wl_surface_alive(w->surface_hold)) {
        pthread_mutex_unlock(&window_mutex);return;
    }
    if(width<=0)width=(int)w->width;if(height<=0)height=(int)w->height;
    if(width==(int)w->width && height==(int)w->height) {pthread_mutex_unlock(&window_mutex);return;}
    w->resizing=1;w->resize_thread=pthread_self();
    struct wpk_allocation *old=w->allocation;
    uint32_t old_width=w->width,old_height=w->height;
    pthread_mutex_unlock(&window_mutex);
    // No window lock across the EGL callback: EGL always precedes native
    // window locking. Other resize/present admission refuses while this exact
    // resize owns its candidate; destruction retains it until we finish.
    free_retired(w);
    w->allocation=NULL;
    int accepted=alloc_buffer(w,width,height)==0;
    if(accepted && _wpk_egl_window_retarget)accepted=_wpk_egl_window_retarget(win);
    if(!accepted) {free_buffer(w);w->allocation=old;w->width=old_width;w->height=old_height;}
    else w->retired=old;
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
    *frame=(struct wpk_wlegl_frame){.fd=w->allocation->back.fd,.handle=w->allocation->back.handle,.width=w->width,.height=w->height};
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
int _wpk_wlegl_prepare_present(void *lease,struct wpk_wlegl_frame *frame) {
    pthread_mutex_lock(&window_mutex);struct wpk_wlegl *w=find_lease(lease);
    int ok=prepare_window(w,frame);
    pthread_mutex_unlock(&window_mutex);
    if(!ok)return 0;
    struct wpk_gbm_frame front;
    for(;;) {
        if(!_wpk_wl_surface_alive(w->surface_hold))break;
        if(_wpk_gbm_window_prepare(w->allocation->lease,&front)) {
            pthread_mutex_lock(&window_mutex);
            int live=w->owner_alive && _wpk_wl_surface_alive(w->surface_hold);
            if(live)w->presenting=1;
            pthread_mutex_unlock(&window_mutex);
            if(!live) {_wpk_gbm_window_finish(w->allocation->lease,0);break;}
            *frame=(struct wpk_wlegl_frame){.fd=front.fd,.handle=front.handle,.width=front.width,.height=front.height};
            return 1;
        }
        if(errno!=EBUSY || wl_display_dispatch_queue((struct wl_display *)w->display,w->queue)<0)break;
    }
    _wpk_wlegl_finish(lease,0);return 0;
}
int _wpk_wlegl_finish(void *lease,int present) {
    pthread_mutex_lock(&window_mutex);struct wpk_wlegl *w=find_lease(lease);
    int ok=w && w->active;
    if(ok && w->presenting) {
        struct wpk_allocation *a=w->allocation;
        _wpk_gbm_window_finish(a->lease,present);
        if(present) {
            struct gbm_bo *bo=gbm_surface_lock_front_buffer(a->surface);
            struct wpk_front *front=bo ? wrap_front(w,a,bo) : NULL;
            if(!front) {if(bo)gbm_surface_release_buffer(a->surface,bo);ok=0;}
            else {
                /* Mark busy before sending. Partial attach/commit failure
                 * leaves ownership uncertain: never recycle that front. */
                front->busy=1;
                ok=w->owner_alive && !w->resizing && _wpk_wl_surface_present(w->surface_hold,
                    front->buffer,(int)w->width,(int)w->height);
                if(ok)free_retired(w);
            }
        }
    } else if(ok && present)ok=0; /* no normalized front was prepared */
    if(w) {w->active=0;w->presenting=0;}
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
    uint32_t result=w ? w->allocation->back.handle : 0;pthread_mutex_unlock(&window_mutex);return result;
}
int _wpk_wlegl_device_fd(void *window) {
    pthread_mutex_lock(&window_mutex);struct wpk_wlegl *w=readable_window(window);
    int result=w ? w->allocation->back.fd : -1;pthread_mutex_unlock(&window_mutex);return result;
}
int _wpk_wlegl_dimensions(void *window,uint32_t *width,uint32_t *height) {
    pthread_mutex_lock(&window_mutex);struct wpk_wlegl *w=readable_window(window);
    if(w) {*width=w->width;*height=w->height;}pthread_mutex_unlock(&window_mutex);return w!=NULL;
}
