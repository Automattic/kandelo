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
#include "drm_owned.h"
#include "wayland-native.h"
#include "wayland-retirement.h"
#include <stdio.h>

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
enum wpk_wlegl_deferred { WLEG_NONE,WLEG_FRAME_PENDING,WLEG_READY,WLEG_COMPLETING,WLEG_BLOCKED };
struct wpk_front {
    struct wpk_allocation *allocation;
    struct gbm_bo *bo;
    struct wl_buffer *buffer;
    int busy,failed;
    struct wpk_gbm_front_hold hold;
    struct wpk_wl_proxy_retirement buffer_retirement;
};
struct wpk_allocation {
    struct gbm_device *gbm;
    struct gbm_surface *surface;
    void *lease;
    struct wpk_gbm_frame back;
    struct wpk_front fronts[4];
    struct wpk_allocation *next;
    struct wpk_drm_owner *owner;
    struct wpk_gbm_front_hold scratch;
    struct wpk_gbm_window_retirement lease_retirement,surface_retirement;
    struct wpk_wl_proxy_retirement params;
    int prime;
};
struct wpk_wlegl {
    struct wl_egl_window *window;
    const void *display;
    uint64_t display_identity,process_epoch;
    void *surface_hold;
    unsigned references;
    int owner_alive, resizing, active, presenting;
    uint32_t width,height;
    struct wpk_wlegl *next;
    struct wl_event_queue *queue;
    struct zwp_linux_dmabuf_v1 *dmabuf;
    struct wpk_allocation *allocation, *retired, *previous, *garbage;
    uint32_t previous_width,previous_height;
    struct wpk_wl_proxy_retirement registry,dmabuf_retirement;
    struct wpk_wl_queue_retirement queue_retirement;
    struct wpk_wl_surface_retirement surface_retirement;
    struct wpk_wl_log_scope logs;
    struct wpk_drm_actor_claim actor;
    struct wpk_wl_boundary_hold boundary;
    struct wpk_wlegl_retirement *release_request;
    uint64_t native_epoch,visit;
    int constructing,operating,deferred_work;
    enum wpk_wlegl_deferred deferred;
    struct wpk_drm_actor_claim deferred_origin;
};

static struct wpk_drm_mutex window_mutex=WPK_DRM_MUTEX_INITIALIZER;
static struct wpk_wlegl *windows;
static uint64_t window_visit;
static void drain_windows(void);
static int cleanup_window(struct wpk_wlegl *);
static int drain_deferred_windows(int cold);
#if defined(__APPLE__)
__attribute__((weak_import)) void _wpk_egl_request_native_drain(void);
#else
__attribute__((weak)) void _wpk_egl_request_native_drain(void);
#endif
static pthread_once_t window_log_once=PTHREAD_ONCE_INIT;
static int window_log_status=EAGAIN;
static struct wpk_wl_log_scope *window_log_scope(void) {
    struct wpk_wl_log_scope *scope=NULL;int duplicate=0;
    _wpk_drm_owned_publication_begin();
    for(struct wpk_wlegl *w=windows;w;w=w->next){
        /* Current claim FIRST: only this exact thread owns these phase fields.
         * Constructors/cleanup have active=0, retarget has presenting=0, and a
         * merely prepared frame has operating=0. A nested handler therefore
         * cannot send another window's diagnostic into its old outer scope. */
        if(!_wpk_drm_actor_claim_current_locked(&w->actor))continue;
        if(!w->active||!w->presenting||!w->operating)continue;
        if(scope){duplicate=1;break;}scope=&w->logs;
    }
    _wpk_drm_owned_publication_end();
    if(duplicate){
        static const char message[]="Kandelo Wayland EGL: ambiguous native diagnostic owner\n";
        (void)write(STDERR_FILENO,message,sizeof message-1);abort();
    }
    return scope;
}
static void initialize_window_logging(void) {
    window_log_status=_wpk_wl_log_set_resolver(window_log_scope)?0:(errno?errno:EIO);
}
static int boundary_window(struct wpk_wlegl *w) {
    if(w->boundary.transferred)return 1;
    if(!w->surface_hold || w->native_epoch==_wpk_drm_native_fork_epoch())return 0;
    if(!_wpk_wl_surface_boundary_required(w->surface_hold))return 0;
    /* WHY: a foreign-fork native connection may contain a vanished mutex
     * owner. Transfer its entire rooted graph, never walk it or close a
     * numeric descriptor that could now name replacement storage. */
    _wpk_drm_owned_publication_begin();
    _wpk_wl_boundary_transfer_locked(&w->boundary);
    /* An EMPTY caller capsule may retire immediately; the retained boundary
     * graph must drop its borrowed callback slot in the same publication. */
    if(w->release_request){w->release_request->live=NULL;w->release_request->retired=NULL;w->release_request=NULL;}
    _wpk_drm_owned_publication_end();return 1;
}
static void queue_garbage_locked(struct wpk_wlegl *w,struct wpk_allocation **slot) {
    if(!*slot)return;
    (*slot)->next=w->garbage;w->garbage=*slot;*slot=NULL;
}
static void queue_garbage(struct wpk_wlegl *w,struct wpk_allocation **slot) {
    _wpk_drm_owned_publication_begin();queue_garbage_locked(w,slot);_wpk_drm_owned_publication_end();
}

/* libEGL re-targets the live window surface at the window's current bo. */
__attribute__((weak)) int _wpk_egl_window_retarget(void *egl_window);

/* ---- zwp_linux_dmabuf_v1 bind (private-queue registry roundtrip) --------- */



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
    struct wpk_wlegl *b = data;
    if (!b->dmabuf && __builtin_strcmp(iface, "zwp_linux_dmabuf_v1") == 0) {
        uint32_t v = version < 3 ? version : 3;
        struct zwp_linux_dmabuf_v1 *proxy=wl_registry_bind(reg,name,&zwp_linux_dmabuf_v1_interface,v);
        _wpk_drm_owned_publication_begin();b->dmabuf=proxy;b->dmabuf_retirement.live=proxy;_wpk_drm_owned_publication_end();
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
static int bind_dmabuf(struct wpk_wlegl *w) {
    struct wl_display *dpy=(void *)w->display;
    struct wl_registry *reg=wl_display_get_registry(dpy);
    _wpk_drm_owned_publication_begin();w->registry.live=reg;_wpk_drm_owned_publication_end();
    if(!reg)return 0;
    wl_proxy_set_queue((void *)reg,w->queue);
    wl_registry_add_listener(reg,&reg_listener,w);
    if(wl_display_roundtrip_queue(dpy,w->queue)<0)return 0;
    if(w->dmabuf){
        zwp_linux_dmabuf_v1_add_listener(w->dmabuf,&dmabuf_listener,NULL);
        if(wl_display_roundtrip_queue(dpy,w->queue)<0)return 0;
    }
    /* No late registry callback may replace the selected dmabuf capability.
     * Its listener data remains durable until local destroy actually completes. */
    if(!w->dmabuf)return 0;
    return _wpk_wl_proxy_destroy_local_pending(&w->registry)==WPK_WL_RETIRE_COMPLETE;
}

/* ---- buffer allocation -------------------------------------------------- */

static void front_release(void *data,struct wl_buffer *buffer) {
    struct wpk_front *front=data;
    if(front->buffer==buffer && front->busy) {
        if(_wpk_gbm_surface_release_buffer_pending(&front->hold)!=0)return;
        _wpk_drm_owned_publication_begin();front->busy=0;_wpk_drm_owned_publication_end();
    }
}
static const struct wl_buffer_listener buffer_listener={.release=front_release};

/* Each listener points into a stable allocation capsule, including across
 * resize. A proxy is created only for a real reserved GBM front, never back. */
static struct wpk_front *wrap_front(struct wpk_wlegl *w,struct wpk_allocation *a,struct gbm_bo *bo) {
    struct wpk_front *front=NULL;
    for(unsigned i=0;i<4;i++){
        if(a->fronts[i].bo==bo&&a->fronts[i].buffer)return &a->fronts[i];
        if(!a->fronts[i].bo&&!front)front=&a->fronts[i];
    }
    if(!front)return NULL;
    a->prime=gbm_bo_get_fd(bo);if(a->prime<0)return NULL;
    struct zwp_linux_buffer_params_v1 *params=zwp_linux_dmabuf_v1_create_params(w->dmabuf);
    _wpk_drm_owned_publication_begin();a->params.live=params;_wpk_drm_owned_publication_end();
    if(!params)goto fail;
    zwp_linux_buffer_params_v1_add(params,a->prime,0,0,gbm_bo_get_stride(bo),
        (uint32_t)(DRM_FORMAT_MOD_LINEAR>>32),(uint32_t)DRM_FORMAT_MOD_LINEAR);
    /* The normalized front is top-row-first; wlroots rejects nonzero flags. */
    struct wl_buffer *buffer=zwp_linux_buffer_params_v1_create_immed(params,
        (int)a->back.width,(int)a->back.height,DRM_FORMAT_XBGR8888,0);
    _wpk_drm_owned_publication_begin();
    front->allocation=a;front->bo=bo;front->buffer=buffer;front->buffer_retirement.live=buffer;
    _wpk_drm_owned_publication_end();
    /* Operation capture delays application log handlers until both the PRIME
     * fd and returned proxies have durable custody. No callback may close and
     * replace this fd before its one ordinary close has completed. */
    close(a->prime);a->prime=-1;
    if(!buffer)goto fail;
    wl_proxy_set_queue((void *)buffer,w->queue);
    if(wl_buffer_add_listener(buffer,&buffer_listener,front)<0){front->failed=1;goto fail;}
    return front;
fail:
    if(a->prime>=0){close(a->prime);a->prime=-1;}
    if(front&&front->bo&&!front->buffer)front->failed=1;
    return NULL;
}
static int cleanup_proxy(struct wpk_wlegl *w,struct wpk_wl_proxy_retirement *state,uint32_t opcode) {
    if(boundary_window(w))return 0;
    int inherited=w->process_epoch!=_wpk_drm_process_generation();
    enum wpk_wl_retire_result r=inherited?_wpk_wl_proxy_discard_pending(state):_wpk_wl_proxy_destroy_pending(state,opcode);
    return r==WPK_WL_RETIRE_COMPLETE&&!boundary_window(w);
}
static int finish_native_scratch(struct wpk_wlegl *w,struct wpk_allocation *a) {
    if(!a)return 1;
    if(!cleanup_proxy(w,&a->params,ZWP_LINUX_BUFFER_PARAMS_V1_DESTROY))return 0;
    for(unsigned i=0;i<4;i++)if(a->fronts[i].failed){
        struct wpk_front *f=&a->fronts[i];
        if(!cleanup_proxy(w,&f->buffer_retirement,WL_BUFFER_DESTROY))return 0;
        _wpk_drm_owned_publication_begin();f->buffer=NULL;f->bo=NULL;f->failed=0;_wpk_drm_owned_publication_end();
    }
    return 1;
}
static int free_allocation(struct wpk_wlegl *w,struct wpk_allocation *a) {
    if(!a)return 1;
    if(!cleanup_proxy(w,&a->params,ZWP_LINUX_BUFFER_PARAMS_V1_DESTROY))return 0;
    if(a->prime>=0){close(a->prime);a->prime=-1;}
    for(unsigned i=0;i<4;i++){
        struct wpk_front *front=&a->fronts[i];
        if(!cleanup_proxy(w,&front->buffer_retirement,WL_BUFFER_DESTROY))return 0;
        _wpk_drm_owned_publication_begin();front->buffer=NULL;_wpk_drm_owned_publication_end();
        if(_wpk_gbm_surface_release_buffer_pending(&front->hold)!=0)return 0;
        _wpk_drm_owned_publication_begin();front->busy=0;front->bo=NULL;_wpk_drm_owned_publication_end();
    }
    if(_wpk_gbm_surface_release_buffer_pending(&a->scratch)!=0)return 0;
    if(!a->lease_retirement.live&&!a->lease_retirement.retired&&a->lease){
        _wpk_drm_owned_publication_begin();a->lease_retirement.live=a->lease;a->lease=NULL;_wpk_drm_owned_publication_end();
    }
    _wpk_gbm_window_release_pending(&a->lease_retirement);
    if(a->lease_retirement.live||a->lease_retirement.retired||boundary_window(w))return 0;
    if(!a->surface_retirement.live&&!a->surface_retirement.retired&&a->surface){
        _wpk_drm_owned_publication_begin();a->surface_retirement.live=a->surface;a->surface=NULL;_wpk_drm_owned_publication_end();
    }
    _wpk_gbm_surface_destroy_pending(&a->surface_retirement);
    if(a->surface_retirement.live||a->surface_retirement.retired||boundary_window(w))return 0;
    _wpk_gbm_device_destroy_pending(&a->gbm);
    _wpk_drm_owned_retire(&a->owner);
    return !a->gbm&&!a->owner;
}
static int free_garbage(struct wpk_wlegl *w) {
    while(w->garbage){
        struct wpk_allocation *a=w->garbage;
        if(!free_allocation(w,a))return 0;
        /* The window stays globally rooted and exclusively claimed across all
         * callbacks. Withdraw a capsule only after every nested actor is EMPTY. */
        _wpk_drm_owned_publication_begin();w->garbage=a->next;free(a);_wpk_drm_owned_publication_end();
    }
    return 1;
}
static int alloc_buffer(struct wpk_wlegl *w,int width,int height) {
    struct wpk_allocation *a=calloc(1,sizeof *a);if(!a)return -1;a->prime=-1;
    _wpk_drm_owned_publication_begin();w->allocation=a;_wpk_drm_owned_publication_end();
    if(_wpk_drm_owned_open(WPK_DRM_OWNED_RENDER_NODE,&a->owner)!=0)return -1;
    a->gbm=_wpk_gbm_device_from_owner(a->owner);_wpk_drm_owned_retire(&a->owner);
    if(!a->gbm)return -1;
    a->surface=gbm_surface_create(a->gbm,(uint32_t)width,(uint32_t)height,GBM_FORMAT_XBGR8888,GBM_BO_USE_RENDERING);
    if(!a->surface||!_wpk_gbm_window_acquire(a->surface,&a->lease,&a->back))return -1;
    struct wpk_gbm_frame initial;
    if(!_wpk_gbm_window_prepare(a->lease,&initial))return -1;
    _wpk_gbm_window_finish(a->lease,1);
    struct gbm_bo *bo=gbm_surface_lock_front_buffer(a->surface);if(!bo)return -1;
    _wpk_drm_owned_publication_begin();a->scratch=(struct wpk_gbm_front_hold){a->surface,bo};_wpk_drm_owned_publication_end();
    struct wpk_front *front=wrap_front(w,a,bo);
    if(_wpk_gbm_surface_release_buffer_pending(&a->scratch)!=0)return -1;
    if(!front)return -1;
    w->width=(uint32_t)width;w->height=(uint32_t)height;return 0;
}
static void free_retired(struct wpk_wlegl *w) {queue_garbage(w,&w->retired);}
static void free_buffer(struct wpk_wlegl *w) {free_retired(w);queue_garbage(w,&w->allocation);queue_garbage(w,&w->previous);}

static int allocation_scratch_pending(struct wpk_allocation *a) {
    if(!a)return 0;
    if(a->params.live||a->params.logs.messages)return 1;
    for(unsigned i=0;i<4;i++)if(a->fronts[i].failed)return 1;
    return 0;
}
static struct wpk_front *wrap_front_captured(struct wpk_wlegl *w,struct wpk_allocation *a,struct gbm_bo *bo) {
    for(unsigned i=0;i<4;i++)if(a->fronts[i].bo==bo&&a->fronts[i].buffer)return &a->fronts[i];
    /* WHY: cached frames have no constructor logging capture/TLS switch.
     * Only creating a real proxy needs scratch custody and deferred handlers. */
    if(!_wpk_wl_log_capture_begin(&w->logs))return NULL;
    struct wpk_front *front=wrap_front(w,a,bo);
    finish_native_scratch(w,a);
    w->deferred_work=allocation_scratch_pending(a);
    _wpk_drm_owned_publication_begin();_wpk_wl_log_capture_end_locked(&w->logs);_wpk_drm_owned_publication_end();
    return front;
}
static void finish_frame_operation(struct wpk_wlegl *w,int preparing) {
    if(w->logs.messages)_wpk_wl_log_defer(&w->logs);
    int work=w->deferred_work||w->garbage||w->logs.messages;
    _wpk_drm_mutex_lock(&window_mutex);_wpk_drm_owned_publication_begin();
    if(work){
        /* WHY: move, do not drop, the exact live origin reference. A ready
         * continuation belongs to that thread until it exits; pthread_t reuse
         * or an epoch-only flag cannot preserve handler delivery authority. */
        if(!w->deferred_origin.scope){w->deferred_origin=w->actor;w->actor.scope=NULL;}
        else _wpk_drm_actor_release_locked(&w->actor);
        w->deferred=preparing?WLEG_FRAME_PENDING:WLEG_READY;
        w->operating=!preparing;
    }else{
        w->operating=0;w->deferred=WLEG_NONE;_wpk_drm_actor_release_locked(&w->actor);_wpk_drm_actor_release_locked(&w->deferred_origin);
    }
    _wpk_drm_owned_publication_end();_wpk_drm_mutex_unlock(&window_mutex);
    if(work&&!preparing){
        /* The real owner is rooted/ready before notification. EGL's existing
         * cold-work flag arranges delivery after its context mutex unlocks. */
        if(_wpk_egl_request_native_drain)_wpk_egl_request_native_drain();
        else drain_deferred_windows(0);
    }
    if(!_wpk_egl_request_native_drain)_wpk_wl_log_drain_deferred();
}

/* Native windows have independent public and EGL lease lifetimes. Only
 * list membership validates untrusted pointers; never inspect their memory. */

static struct wpk_wlegl *find_window(const void *native) {
    for(struct wpk_wlegl *w=windows;w;w=w->next)if(w->window==native && w->owner_alive && !w->constructing && !w->boundary.transferred)return w;
    return NULL;
}
static int resize_actor_locked(struct wpk_wlegl *w) {
    if(!w->resizing)return 0;
    _wpk_drm_owned_publication_begin();int current=_wpk_drm_actor_claim_current_locked(&w->actor);_wpk_drm_owned_publication_end();return current;
}
static struct wpk_wlegl *readable_window(const void *native) {
    struct wpk_wlegl *w=find_window(native);
    if(w&&w->process_epoch!=_wpk_drm_process_generation())return NULL;
    return w && w->resizing && !resize_actor_locked(w) ? NULL : w;
}
static struct wpk_wlegl *find_lease(void *lease) {
    for(struct wpk_wlegl *w=windows;w;w=w->next)if(w==lease && w->references)return w;
    return NULL;
}
static struct wpk_wlegl *collect_window(struct wpk_wlegl *w) {
    if(w->owner_alive||w->references||w->active||w->resizing||w->constructing||w->boundary.transferred)return NULL;
    return w;
}
static int window_collectible(struct wpk_wlegl *w) {
    _wpk_drm_mutex_lock(&window_mutex);int result=collect_window(w)!=NULL;_wpk_drm_mutex_unlock(&window_mutex);return result;
}
static int cleanup_window(struct wpk_wlegl *w) {
    if(boundary_window(w))return WPK_WL_RETIRE_BOUNDARY_TRANSFERRED;
    free_buffer(w);
    if(!free_garbage(w))return w->boundary.transferred?WPK_WL_RETIRE_BOUNDARY_TRANSFERRED:WPK_WL_RETIRE_PENDING;
    /* A callback can fork and RETURN into this stack. Classification belongs
     * to each next native leaf, not to an inherited boolean cached before it. */
    if(boundary_window(w))return WPK_WL_RETIRE_BOUNDARY_TRANSFERRED;
    int inherited=w->process_epoch!=_wpk_drm_process_generation();
    if((inherited?_wpk_wl_proxy_discard_pending(&w->registry):_wpk_wl_proxy_destroy_local_pending(&w->registry))!=WPK_WL_RETIRE_COMPLETE)return WPK_WL_RETIRE_PENDING;
    if(!cleanup_proxy(w,&w->dmabuf_retirement,ZWP_LINUX_DMABUF_V1_DESTROY))return w->boundary.transferred?WPK_WL_RETIRE_BOUNDARY_TRANSFERRED:WPK_WL_RETIRE_PENDING;
    w->dmabuf=NULL;
    if(boundary_window(w))return WPK_WL_RETIRE_BOUNDARY_TRANSFERRED;
    inherited=w->process_epoch!=_wpk_drm_process_generation();
    enum wpk_wl_retire_result r=inherited?_wpk_wl_queue_discard_pending(&w->queue_retirement):_wpk_wl_queue_destroy_pending(&w->queue_retirement);
    if(r!=WPK_WL_RETIRE_COMPLETE)return r;
    w->queue=NULL;
    if(boundary_window(w))return WPK_WL_RETIRE_BOUNDARY_TRANSFERRED;
    if(!w->surface_retirement.live&&!w->surface_retirement.retired&&w->surface_hold){
        _wpk_drm_owned_publication_begin();w->surface_retirement.live=w->surface_hold;w->surface_hold=NULL;_wpk_drm_owned_publication_end();
    }
    r=_wpk_wl_surface_release_pending(&w->surface_retirement);
    if(r!=WPK_WL_RETIRE_COMPLETE)return r;
    return _wpk_wl_log_deliver(&w->logs)?WPK_WL_RETIRE_COMPLETE:WPK_WL_RETIRE_PENDING;
}
static int finish_claimed_window(struct wpk_wlegl *w) {
    int result=cleanup_window(w);
    _wpk_drm_mutex_lock(&window_mutex);_wpk_drm_owned_publication_begin();
    if(result==WPK_WL_RETIRE_BOUNDARY_TRANSFERRED&&!w->boundary.transferred)_wpk_wl_boundary_transfer_locked(&w->boundary);
    if(result==WPK_WL_RETIRE_COMPLETE||result==WPK_WL_RETIRE_BOUNDARY_TRANSFERRED){
        struct wpk_wlegl **p=&windows;while(*p&&*p!=w)p=&(*p)->next;
        if(*p)*p=w->next;
        if(w->release_request){w->release_request->live=NULL;w->release_request->retired=NULL;w->release_request=NULL;}
        _wpk_drm_actor_release_locked(&w->actor);_wpk_drm_actor_release_locked(&w->deferred_origin);
        if(result==WPK_WL_RETIRE_COMPLETE){free(w->window);free(w);}
    }else _wpk_drm_actor_release_locked(&w->actor);
    _wpk_drm_owned_publication_end();_wpk_drm_mutex_unlock(&window_mutex);return result;
}
static void recover_operation(struct wpk_wlegl *w) {
    if(w->active&&w->presenting&&w->allocation)_wpk_gbm_window_finish(w->allocation->lease,0);
    if(w->allocation&&_wpk_gbm_surface_release_buffer_pending(&w->allocation->scratch)!=0)return;
    _wpk_drm_mutex_lock(&window_mutex);_wpk_drm_owned_publication_begin();
    if(w->constructing){w->constructing=0;w->owner_alive=0;}
    if(w->resizing){
        queue_garbage_locked(w,&w->allocation);w->allocation=w->previous;w->previous=NULL;
        w->width=w->previous_width;w->height=w->previous_height;w->resizing=0;
    }
    w->active=w->presenting=0;w->operating=1;
    _wpk_drm_owned_publication_end();_wpk_drm_mutex_unlock(&window_mutex);
}
static void drain_windows(void) {
    int cancel;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&cancel);
    drain_deferred_windows(1);
    if(!_wpk_drm_actor_prepare()){
        static const char failure[]="Kandelo Wayland EGL: cleanup actor unavailable; rooted custody retained\n";
        (void)write(STDERR_FILENO,failure,sizeof failure-1);pthread_setcancelstate(cancel,NULL);return;
    }
    _wpk_drm_mutex_lock(&window_mutex);uint64_t visit=++window_visit;if(!visit)abort();
    size_t budget=0;for(struct wpk_wlegl *p=windows;p;p=p->next)budget++;
    _wpk_drm_mutex_unlock(&window_mutex);
    /* A reentrant callback may enqueue or revisit arbitrary records. Limit
     * this cold pass to its initial population, never retain a list cursor. */
    while(budget--){
        _wpk_drm_mutex_lock(&window_mutex);_wpk_drm_owned_publication_begin();struct wpk_wlegl *chosen=NULL;int resume=0;
        for(struct wpk_wlegl *w=windows;w;w=w->next){
            if(w->visit==visit||w->boundary.transferred||w->deferred!=WLEG_NONE)continue;
            if(w->operating||w->constructing||w->resizing){
                if(_wpk_drm_actor_claim_live_locked(&w->actor))continue;
            }else if(!collect_window(w)&&!w->garbage&&!w->logs.messages)continue;
            if(!_wpk_drm_actor_try_claim_locked(&w->actor))continue;
            w->visit=visit;resume=w->operating||w->constructing||w->resizing;w->operating=1;chosen=w;break;
        }
        _wpk_drm_owned_publication_end();_wpk_drm_mutex_unlock(&window_mutex);if(!chosen)break;
        if(boundary_window(chosen)){finish_claimed_window(chosen);continue;}
        if(resume)recover_operation(chosen);
        if(window_collectible(chosen)){finish_claimed_window(chosen);continue;}
        finish_native_scratch(chosen,chosen->allocation);free_garbage(chosen);_wpk_wl_log_deliver(&chosen->logs);
        if(chosen->boundary.transferred){finish_claimed_window(chosen);continue;}
        _wpk_drm_mutex_lock(&window_mutex);_wpk_drm_owned_publication_begin();
        int retire=collect_window(chosen)!=NULL;
        if(!retire){chosen->operating=0;_wpk_drm_actor_release_locked(&chosen->actor);}
        _wpk_drm_owned_publication_end();_wpk_drm_mutex_unlock(&window_mutex);
        if(retire)finish_claimed_window(chosen);
    }
    pthread_setcancelstate(cancel,NULL);
}
struct wl_egl_window *wl_egl_window_create(struct wl_surface *surface,int width,int height) {
    if(!surface||width<=0||height<=0)return NULL;
    drain_windows();int cancel;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&cancel);
    if(!_wpk_drm_actor_prepare()){pthread_setcancelstate(cancel,NULL);return NULL;}
    if(pthread_once(&window_log_once,initialize_window_logging)||window_log_status){
        errno=window_log_status;pthread_setcancelstate(cancel,NULL);return NULL;
    }
    struct wl_egl_window *win=calloc(1,sizeof *win);struct wpk_wlegl *w=calloc(1,sizeof *w);
    if(!win||!w){free(win);free(w);pthread_setcancelstate(cancel,NULL);return NULL;}
    w->window=win;w->process_epoch=_wpk_drm_process_generation();w->native_epoch=_wpk_drm_native_fork_epoch();w->boundary.owner=w;
    /* WHY: even a rejected constructor owns real native/device resources.
     * Root it before the first effect; public selection excludes constructing
     * nodes, while an ended callback's actor can finish their cleanup. */
    w->constructing=w->operating=1;
    _wpk_drm_mutex_lock(&window_mutex);_wpk_drm_owned_publication_begin();
    w->next=windows;windows=w;if(!_wpk_drm_actor_try_claim_locked(&w->actor))abort();
    _wpk_drm_owned_publication_end();_wpk_drm_mutex_unlock(&window_mutex);
    int ok=_wpk_wl_log_capture_begin(&w->logs);
    if(ok){
        int acquired=_wpk_wl_surface_acquire_pending(surface,&w->display,&w->display_identity,&w->surface_hold);
        if(acquired&&w->surface_hold){
            w->queue=wl_display_create_queue((void *)w->display);
            _wpk_drm_owned_publication_begin();w->queue_retirement.live=w->queue;_wpk_drm_owned_publication_end();
            ok=w->queue&&bind_dmabuf(w)&&alloc_buffer(w,width,height)==0;
            if(ok&&!finish_native_scratch(w,w->allocation))ok=0;
        }else ok=0;
        _wpk_drm_owned_publication_begin();_wpk_wl_log_capture_end_locked(&w->logs);_wpk_drm_owned_publication_end();
    }
    if(!_wpk_wl_log_deliver(&w->logs))ok=0;
    if(w->process_epoch!=_wpk_drm_process_generation())ok=0;
    _wpk_drm_mutex_lock(&window_mutex);_wpk_drm_owned_publication_begin();
    if(ok){
        *(intptr_t *)&win->version=WL_EGL_WINDOW_VERSION;win->width=win->attached_width=width;win->height=win->attached_height=height;
        win->surface=surface;win->driver_private=w;w->owner_alive=1;
    }
    w->constructing=w->operating=0;_wpk_drm_actor_release_locked(&w->actor);
    _wpk_drm_owned_publication_end();_wpk_drm_mutex_unlock(&window_mutex);
    drain_windows();pthread_setcancelstate(cancel,NULL);return ok?win:NULL;
}
void wl_egl_window_destroy(struct wl_egl_window *win) {
    _wpk_drm_mutex_lock(&window_mutex);struct wpk_wlegl *w=find_window(win);
    if(w){_wpk_drm_owned_publication_begin();w->owner_alive=0;_wpk_drm_owned_publication_end();}
    _wpk_drm_mutex_unlock(&window_mutex);drain_windows();
}
void wl_egl_window_resize(struct wl_egl_window *win,int width,int height,int dx,int dy) {
    drain_windows();int cancel;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&cancel);
    if(!_wpk_drm_actor_prepare()){pthread_setcancelstate(cancel,NULL);return;}
    _wpk_drm_mutex_lock(&window_mutex);struct wpk_wlegl *w=find_window(win);
    if(!w||w->process_epoch!=_wpk_drm_process_generation()||w->resizing||w->active||w->operating||!_wpk_wl_surface_alive(w->surface_hold))goto unlock;
    if(width<=0)width=(int)w->width;if(height<=0)height=(int)w->height;
    if(width==(int)w->width&&height==(int)w->height)goto unlock;
    _wpk_drm_owned_publication_begin();
    if(!_wpk_drm_actor_try_claim_locked(&w->actor)){_wpk_drm_owned_publication_end();goto unlock;}
    w->resizing=w->operating=1;w->previous=w->allocation;w->allocation=NULL;
    w->previous_width=w->width;w->previous_height=w->height;queue_garbage_locked(w,&w->retired);
    _wpk_drm_owned_publication_end();_wpk_drm_mutex_unlock(&window_mutex);
    int accepted=_wpk_wl_log_capture_begin(&w->logs);
    if(accepted){accepted=alloc_buffer(w,width,height)==0;if(accepted&&!finish_native_scratch(w,w->allocation))accepted=0;_wpk_drm_owned_publication_begin();_wpk_wl_log_capture_end_locked(&w->logs);_wpk_drm_owned_publication_end();}
    if(accepted&&_wpk_egl_window_retarget)accepted=_wpk_egl_window_retarget(win);
    if(w->process_epoch!=_wpk_drm_process_generation())accepted=0;
    _wpk_drm_mutex_lock(&window_mutex);_wpk_drm_owned_publication_begin();
    if(accepted){w->retired=w->previous;w->previous=NULL;win->width=win->attached_width=width;win->height=win->attached_height=height;win->dx=dx;win->dy=dy;}
    else{queue_garbage_locked(w,&w->allocation);w->allocation=w->previous;w->previous=NULL;w->width=w->previous_width;w->height=w->previous_height;}
    w->resizing=0;_wpk_drm_owned_publication_end();_wpk_drm_mutex_unlock(&window_mutex);
    free_garbage(w);_wpk_wl_log_deliver(&w->logs);
    _wpk_drm_mutex_lock(&window_mutex);_wpk_drm_owned_publication_begin();w->operating=0;_wpk_drm_actor_release_locked(&w->actor);_wpk_drm_owned_publication_end();
    _wpk_drm_mutex_unlock(&window_mutex);drain_windows();pthread_setcancelstate(cancel,NULL);return;
unlock:
    _wpk_drm_mutex_unlock(&window_mutex);pthread_setcancelstate(cancel,NULL);
}
void wl_egl_window_get_attached_size(struct wl_egl_window *win,int *width,int *height) {
    _wpk_drm_mutex_lock(&window_mutex);struct wpk_wlegl *w=find_window(win);
    if(width)*width=w ? win->attached_width : 0;if(height)*height=w ? win->attached_height : 0;
    _wpk_drm_mutex_unlock(&window_mutex);
}
static int prepare_window(struct wpk_wlegl *w,struct wpk_wlegl_frame *frame) {
    if(!w||!w->allocation||w->constructing||w->boundary.transferred||w->process_epoch!=_wpk_drm_process_generation()||!w->owner_alive||w->active)return 0;
    /* WHY: EGL retarget obtains a metadata frame from inside the live resize
     * operation. Keep that outer claim, while refusing peers and dead/reused
     * pthread IDs; frame rendering itself still cannot claim this busy node. */
    if((w->resizing||w->operating)&&!resize_actor_locked(w))return 0;
    if(!_wpk_wl_surface_alive(w->surface_hold))return 0;
    w->active=1;
    *frame=(struct wpk_wlegl_frame){.fd=w->allocation->back.fd,.handle=w->allocation->back.handle,.width=w->width,.height=w->height,.owner=w->allocation->back.owner,.bo_owner=w->allocation->back.bo_owner};
    return 1;
}
int _wpk_wlegl_acquire(const void *window,const void *display,uint64_t identity,void **lease,struct wpk_wlegl_frame *frame) {
    _wpk_drm_mutex_lock(&window_mutex);struct wpk_wlegl *w=find_window(window);
    int ok=w && (!display || (w->display==display && w->display_identity==identity))
        && w->references<UINT_MAX && prepare_window(w,frame);
    if(ok) {
        /* The EGL caller roots this slot before admission. Keep its new edge
         * and the reference in one fork snapshot; a detached count cannot
         * prove caller custody. Cached frame preparation does not come here. */
        _wpk_drm_owned_publication_begin();w->references++;*lease=w;
        _wpk_drm_owned_publication_end();
    }
    _wpk_drm_mutex_unlock(&window_mutex);return ok;
}
int _wpk_wlegl_prepare(void *lease,struct wpk_wlegl_frame *frame) {
    _wpk_drm_mutex_lock(&window_mutex);int ok=prepare_window(find_lease(lease),frame);
    _wpk_drm_mutex_unlock(&window_mutex);return ok;
}
int _wpk_wlegl_prepare_present(void *lease,struct wpk_wlegl_frame *frame) {
    int cancel;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&cancel);
    if(!_wpk_drm_actor_prepare()){pthread_setcancelstate(cancel,NULL);return 0;}
    _wpk_drm_mutex_lock(&window_mutex);struct wpk_wlegl *w=find_lease(lease);
    int ok=prepare_window(w,frame);
    if(ok){
        _wpk_drm_owned_publication_begin();ok=_wpk_drm_actor_try_claim_locked(&w->actor);if(ok)w->operating=1;else w->active=0;_wpk_drm_owned_publication_end();
    }
    _wpk_drm_mutex_unlock(&window_mutex);if(!ok){pthread_setcancelstate(cancel,NULL);return 0;}
    struct wpk_gbm_frame front;
    {
        ok=0;
        for(;;){
            if(!_wpk_wl_surface_alive(w->surface_hold))break;
            if(_wpk_gbm_window_prepare(w->allocation->lease,&front)){
                _wpk_drm_mutex_lock(&window_mutex);ok=w->owner_alive&&_wpk_wl_surface_alive(w->surface_hold);
                if(ok)w->presenting=1;_wpk_drm_mutex_unlock(&window_mutex);
                if(!ok)_wpk_gbm_window_finish(w->allocation->lease,0);
                break;
            }
            if(errno!=EBUSY)break;
            /* Dispatch is already a bounded-ring backpressure slow path. Its
             * private listeners never deliver application default-queue events. */
            if(!_wpk_wl_log_capture_begin(&w->logs))break;
            int dispatched=wl_display_dispatch_queue((void *)w->display,w->queue);
            _wpk_drm_owned_publication_begin();_wpk_wl_log_capture_end_locked(&w->logs);_wpk_drm_owned_publication_end();
            /* Logging is not a second native error channel. Preserve a
             * successful dispatch and defer its exact diagnostic; handlers
             * still run only after EGL has published progress and unlocked. */
            if(w->logs.messages)_wpk_wl_log_defer(&w->logs);
            if(dispatched<0)break;
        }
    }
    if(ok)*frame=(struct wpk_wlegl_frame){.fd=front.fd,.handle=front.handle,.width=front.width,.height=front.height,.owner=front.owner,.bo_owner=front.bo_owner};
    if(!ok){_wpk_drm_mutex_lock(&window_mutex);w->active=w->presenting=0;_wpk_drm_mutex_unlock(&window_mutex);}
    finish_frame_operation(w,ok);
    pthread_setcancelstate(cancel,NULL);return ok;
}
int _wpk_wlegl_finish(void *lease,int present) {
    int cancel;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&cancel);
    if(!_wpk_drm_actor_prepare()){pthread_setcancelstate(cancel,NULL);return 0;}
    _wpk_drm_mutex_lock(&window_mutex);struct wpk_wlegl *w=find_lease(lease);
    if(w&&w->active&&w->operating&&resize_actor_locked(w)){
        int metadata=!present&&!w->presenting;
        _wpk_drm_owned_publication_begin();w->active=w->presenting=0;_wpk_drm_owned_publication_end();
        _wpk_drm_mutex_unlock(&window_mutex);pthread_setcancelstate(cancel,NULL);return metadata;
    }
    int ok=w&&w->active&&!w->operating;
    if(ok){_wpk_drm_owned_publication_begin();ok=_wpk_drm_actor_try_claim_locked(&w->actor);if(ok)w->operating=1;_wpk_drm_owned_publication_end();}
    _wpk_drm_mutex_unlock(&window_mutex);if(!ok){pthread_setcancelstate(cancel,NULL);return 0;}
    if(w->presenting){
        struct wpk_allocation *a=w->allocation;_wpk_gbm_window_finish(a->lease,present);
        if(present){
            struct gbm_bo *bo=gbm_surface_lock_front_buffer(a->surface);
            if(bo){_wpk_drm_owned_publication_begin();a->scratch=(struct wpk_gbm_front_hold){a->surface,bo};_wpk_drm_owned_publication_end();}
            struct wpk_front *front=bo?wrap_front_captured(w,a,bo):NULL;
            if(!front){if(_wpk_gbm_surface_release_buffer_pending(&a->scratch)!=0)abort();ok=0;}
            else{
                /* Native attach/commit may have taken effect even on failure.
                 * Publish the exact reserved hold before its first marshal. */
                _wpk_drm_mutex_lock(&window_mutex);_wpk_drm_owned_publication_begin();
                front->hold=a->scratch;a->scratch=(struct wpk_gbm_front_hold){0};front->busy=1;
                int admitted=w->owner_alive&&!w->resizing;
                _wpk_drm_owned_publication_end();_wpk_drm_mutex_unlock(&window_mutex);
                /* Cold constructor messages need their own rooted owner before
                 * actual-log-only present capture can reuse this empty scope. */
                int diagnostics=!w->logs.messages||_wpk_wl_log_defer(&w->logs);
                ok=admitted&&diagnostics&&_wpk_wl_surface_present(w->surface_hold,front->buffer,(int)w->width,(int)w->height);
                if(ok)free_retired(w);
            }
        }
    }else if(present)ok=0;
    _wpk_drm_mutex_lock(&window_mutex);_wpk_drm_owned_publication_begin();w->active=w->presenting=0;
    /* Result/phase seal and lazy capture detachment are one publication.
     * A fork must not inherit completed native progress with a dead active
     * capture, nor may a handler reenter while this frame still looks active. */
    if(w->logs.capturing)_wpk_wl_log_capture_end_locked(&w->logs);
    _wpk_drm_owned_publication_end();_wpk_drm_mutex_unlock(&window_mutex);
    finish_frame_operation(w,0);
    pthread_setcancelstate(cancel,NULL);return ok;
}
static int drain_deferred_windows(int cold) {
    int cancel;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&cancel);
    if(!_wpk_drm_actor_prepare()){pthread_setcancelstate(cancel,NULL);return 0;}
    _wpk_drm_mutex_lock(&window_mutex);uint64_t visit=++window_visit;if(!visit)abort();
    size_t budget=0;for(struct wpk_wlegl *p=windows;p;p=p->next)budget++;
    _wpk_drm_mutex_unlock(&window_mutex);
    int rearm=0;
    while(budget--){
        _wpk_drm_mutex_lock(&window_mutex);_wpk_drm_owned_publication_begin();struct wpk_wlegl *w=NULL;int abandoned=0;
        for(struct wpk_wlegl *p=windows;p;p=p->next){
            if(p->visit==visit||p->deferred==WLEG_NONE||p->boundary.transferred)continue;
            p->visit=visit;
            int origin_live=_wpk_drm_actor_claim_live_locked(&p->deferred_origin);
            int own_origin=_wpk_drm_actor_claim_current_locked(&p->deferred_origin);
            if(p->deferred==WLEG_FRAME_PENDING&&origin_live)continue;
            if(p->deferred==WLEG_BLOCKED&&!cold)continue;
            if(p->deferred!=WLEG_COMPLETING&&origin_live&&!own_origin){if(p->deferred==WLEG_READY)rearm=1;continue;}
            if(!_wpk_drm_actor_try_claim_locked(&p->actor))continue;
            abandoned=p->deferred==WLEG_FRAME_PENDING;p->deferred=WLEG_COMPLETING;p->operating=1;w=p;break;
        }
        _wpk_drm_owned_publication_end();_wpk_drm_mutex_unlock(&window_mutex);if(!w)break;
        if(boundary_window(w)){finish_claimed_window(w);continue;}
        if(abandoned)recover_operation(w);
        int complete=finish_native_scratch(w,w->allocation)&&free_garbage(w)&&_wpk_wl_log_deliver(&w->logs);
        if(w->boundary.transferred){finish_claimed_window(w);continue;}
        _wpk_drm_mutex_lock(&window_mutex);_wpk_drm_owned_publication_begin();
        /* WHY: last owner withdrawal and completion cannot pass each other.
         * Decide collection and release the actor in one metadata transaction;
         * a stale unlocked check could leave the final capsule queued forever. */
        int retire=complete&&collect_window(w);
        if(!retire){
            if(complete){w->deferred=WLEG_NONE;w->deferred_work=0;w->operating=0;_wpk_drm_actor_release_locked(&w->deferred_origin);}
            else w->deferred=WLEG_BLOCKED;
            _wpk_drm_actor_release_locked(&w->actor);
        }
        _wpk_drm_owned_publication_end();_wpk_drm_mutex_unlock(&window_mutex);
        if(retire)finish_claimed_window(w);
    }
    pthread_setcancelstate(cancel,NULL);return rearm;
}
int _wpk_wlegl_drain_deferred(void){return drain_deferred_windows(0);}

enum wpk_wl_retire_result _wpk_wlegl_release_pending(struct wpk_wlegl_retirement *state) {
    if(!state)return WPK_WL_RETIRE_ERROR;
    int cancel;pthread_setcancelstate(PTHREAD_CANCEL_DISABLE,&cancel);
    int prepared=_wpk_drm_actor_prepare(),claimed=0;
    _wpk_drm_mutex_lock(&window_mutex);_wpk_drm_owned_publication_begin();struct wpk_wlegl *w=NULL;
    if(state->live){
        for(w=windows;w;w=w->next)if(w==state->live)break;
        if(!w||!w->references){_wpk_drm_owned_publication_end();_wpk_drm_mutex_unlock(&window_mutex);pthread_setcancelstate(cancel,NULL);return WPK_WL_RETIRE_ERROR;}
        --w->references;state->live=NULL;
        if(!w->owner_alive&&!w->references){state->retired=w;w->release_request=state;}
    }
    if(state->retired){
        for(w=windows;w;w=w->next)if(w==state->retired)break;
        if(!w)abort();
        if(prepared&&w->deferred==WLEG_NONE&&collect_window(w))claimed=_wpk_drm_actor_try_claim_locked(&w->actor);
    }
    _wpk_drm_owned_publication_end();_wpk_drm_mutex_unlock(&window_mutex);
    int result=claimed?finish_claimed_window(w):(state->live||state->retired?WPK_WL_RETIRE_PENDING:WPK_WL_RETIRE_COMPLETE);
    pthread_setcancelstate(cancel,NULL);return result;
}
void _wpk_wlegl_release_inherited(void *lease) {_wpk_wlegl_release(lease);}
void _wpk_wlegl_release(void *lease) {
    _wpk_drm_mutex_lock(&window_mutex);struct wpk_wlegl *w=find_lease(lease);
    if(w){_wpk_drm_owned_publication_begin();--w->references;_wpk_drm_owned_publication_end();}
    _wpk_drm_mutex_unlock(&window_mutex);drain_windows();
}
/* Legacy metadata entry points stay safe for callers that only inspect a
 * live native window. EGL itself uses the retained typed lease above. */
uint32_t _wpk_wlegl_bo_handle(void *window) {
    _wpk_drm_mutex_lock(&window_mutex);struct wpk_wlegl *w=readable_window(window);
    uint32_t result=w ? w->allocation->back.handle : 0;_wpk_drm_mutex_unlock(&window_mutex);return result;
}
int _wpk_wlegl_device_fd(void *window) {
    _wpk_drm_mutex_lock(&window_mutex);struct wpk_wlegl *w=readable_window(window);
    int result=w ? w->allocation->back.fd : -1;_wpk_drm_mutex_unlock(&window_mutex);return result;
}
int _wpk_wlegl_dimensions(void *window,uint32_t *width,uint32_t *height) {
    _wpk_drm_mutex_lock(&window_mutex);struct wpk_wlegl *w=readable_window(window);
    if(w) {*width=w->width;*height=w->height;}_wpk_drm_mutex_unlock(&window_mutex);return w!=NULL;
}
