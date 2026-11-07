/* Actual native-window allocation/resize/retirement with device and Wayland
 * doubles. This proves descriptor ownership, not compositor integration. */
#include <assert.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/mman.h>
#include "owned-resource-peer.h"
static int window_open(const char *, int, ...);
static int window_close(int);
#include "drm_owned.h"
static void window_mutex_lock_phase(struct wpk_drm_mutex *);
static void (*window_before_lock)(void);
#define _wpk_drm_mutex_lock window_mutex_lock_phase
#define _wpk_wlegl_finish window_finish_impl
#define open window_open
#define close window_close
#ifndef WPK_WAYLAND_WINDOW_SOURCE
#define WPK_WAYLAND_WINDOW_SOURCE "../../../libc/glue/libwayland-egl.c"
#endif
#include WPK_WAYLAND_WINDOW_SOURCE
#include "wayland-retirement.h"
#undef open
#undef close
#undef _wpk_drm_mutex_lock
#undef _wpk_wlegl_finish
static void window_mutex_lock_phase(struct wpk_drm_mutex *mutex){
    if(mutex==&window_mutex&&window_before_lock)window_before_lock();
    _wpk_drm_mutex_lock(mutex);
}

struct gbm_device {
    int fd;
    struct wpk_drm_owner *owner;
};
struct gbm_bo {
    struct gbm_device *device;
    uint32_t width, height, handle;
    struct wpk_drm_owner *owner;
};
static void (*window_native_hook)(void);
static void window_native_log(void);
static int window_log_on_buffer,window_log_on_dispatch,window_log_on_present;
static void (*window_present_hook)(void);
static wpk_wl_log_resolver window_resolver;
static struct wpk_wl_log_scope *window_resolved_scope;
static unsigned window_resolver_calls;
static int window_exit_retarget,window_leaf_defer_once,window_boundary_required,window_retarget_error;
static void (*window_acquire_phase)(void);
static unsigned window_boundary_queries;
static uint64_t window_native_epoch;
static unsigned window_native_destroys,window_capture_count,window_protocol_destroys;
static _Thread_local int window_local_destroy;
static int window_facade_locked,window_requested;
int _wpk_wlegl_drain_deferred(void);
int _wpk_wlegl_finish(void *lease,int present){
    int result=window_finish_impl(lease,present);
    if(!window_facade_locked&&window_requested){
        window_requested=0;int rearm=_wpk_wlegl_drain_deferred();rearm|=_wpk_wl_log_drain_deferred();if(rearm)window_requested=1;
    }
    return result;
}
static int descriptors[16], exported[16], fail_device, fail_bo, fail_export, fail_params, fail_buffer,
    reject_retarget, destroy_during_retarget;
static unsigned opens, closed, bo_created, bo_destroyed;
static int window_open(const char *path, int flags, ...) {
    assert(!strcmp(path, WPK_GL_DEVICE) && (flags & O_CLOEXEC));
    for (unsigned i = 0; i < 16; i++)
        if (!descriptors[i]) {
            descriptors[i] = 1;
            opens++;
            return 100 + i;
        }
    assert(!"descriptor registry exhausted");
    return -1;
}
static int window_close(int fd) {
    if (fd >= 300 && fd < 316) {
        assert(exported[fd - 300]);
        exported[fd - 300] = 0;
        return 0;
    }
    assert(fd >= 100 && fd < 116 && descriptors[fd - 100]);
    descriptors[fd - 100] = 0;
    closed++;
    return 0;
}
struct graphics_peer_file {unsigned refs;int slot,alias;};
static struct graphics_peer_file window_files[32];
static struct graphics_peer_file *window_aliases[512];
static struct graphics_peer_file *window_peer_open(uint32_t node){
    assert(node==WPK_DRM_OWNED_RENDER_NODE);int fd=window_open(WPK_GL_DEVICE,O_RDWR|O_CLOEXEC);
    for(unsigned i=0;i<32;i++)if(!window_files[i].refs){window_files[i]=(struct graphics_peer_file){1,fd,-1};return &window_files[i];}
    assert(!"native window resource slots exhausted");return NULL;
}
static struct graphics_peer_file *window_peer_acquire(int fd,uint32_t flags){
    assert(!flags);struct graphics_peer_file *file=fd>=0&&fd<512?window_aliases[fd]:NULL;
    if(!file){errno=EBADF;return NULL;}file->refs++;return file;
}
static void window_peer_retain(struct graphics_peer_file *file){assert(file->refs);file->refs++;}
static int window_peer_release(struct graphics_peer_file *file){assert(file->refs);return --file->refs?0:window_close(file->slot);}
static int window_peer_matches(struct graphics_peer_file *file,int fd){return fd>=0&&fd<512&&window_aliases[fd]==file;}
static int window_peer_close(struct graphics_peer_file *file,int fd){assert(window_peer_matches(file,fd));window_aliases[fd]=NULL;file->alias=-1;return 0;}
static int window_peer_duplicate(struct graphics_peer_file *file,int previous,int borrowed){
    (void)borrowed;if(window_peer_matches(file,previous))return previous;
    int fd=file->slot;assert(!window_aliases[fd]);window_aliases[fd]=file;file->alias=fd;return fd;
}
static int window_peer_io(struct graphics_peer_file *file,uint32_t request,void *body,uint32_t length,struct graphics_peer_file *source,const struct graphics_peer_binding *proofs,uint32_t count){
    (void)proofs;assert(!count);
    (void)file;(void)body;assert(request==UINT32_C(0xc004fe01)&&length==4&&!source);return 0;
}
static int window_peer_info(struct graphics_peer_file *file,uint32_t handle,uint64_t *storage,struct wpk_drm_bo_info *info){
    *storage=handle;
    (void)file;assert(handle);*info=(struct wpk_drm_bo_info){4096,32,32,128,GBM_FORMAT_XBGR8888,1,0};return 0;
}
static int window_peer_bo_release(struct graphics_peer_file *file,uint32_t handle,uint64_t storage){assert(storage==handle);(void)file;assert(handle);return 0;}
static void *window_peer_map(struct graphics_peer_file *file,uint64_t address,uint64_t length,int64_t offset,uint32_t prot,uint32_t flags,uint32_t handle,uint64_t storage){
    (void)storage;(void)file;(void)address;(void)length;(void)offset;(void)prot;(void)flags;(void)handle;assert(!"window bridge has no CPU maps");return MAP_FAILED;
}
static int window_peer_poll(struct graphics_peer_file *file,uint32_t events,int32_t timeout,uint32_t *revents){(void)file;(void)events;(void)timeout;(void)revents;assert(!"window bridge has no sync files");return -1;}
static const struct graphics_peer_ops window_peer_ops={window_peer_open,window_peer_acquire,window_peer_retain,window_peer_release,window_peer_duplicate,window_peer_matches,window_peer_close,window_peer_io,window_peer_info,window_peer_bo_release,window_peer_map,window_peer_poll};
int window_owned_ioctl(int fd,unsigned long request,...){
    assert(fd==-1&&request==WPK_DRM_IOCTL_OWNED_RESOURCE);va_list args;va_start(args,request);void *packet=va_arg(args,void *);va_end(args);return graphics_peer_ioctl(&window_peer_ops,packet);
}
struct gbm_device *_wpk_gbm_device_from_owner(struct wpk_drm_owner *owner){
    if(fail_device)return NULL;struct gbm_device *device=malloc(sizeof *device);assert(device);
    assert(!_wpk_drm_owned_retain(owner));device->owner=owner;
    device->fd=_wpk_drm_owned_fd(owner,-1,O_CLOEXEC|WPK_DRM_OWNED_BORROW_ALIAS);assert(device->fd>=0);return device;
}
struct gbm_device *gbm_create_device(int fd){
    struct wpk_drm_owner *owner=NULL;if(_wpk_drm_owned_acquire(fd,0,&owner))return NULL;
    struct gbm_device *device=_wpk_gbm_device_from_owner(owner);_wpk_drm_owned_retire(&owner);return device;
}

int gbm_device_get_fd(struct gbm_device *device) { return device->fd; }
void gbm_device_destroy(struct gbm_device *device) {
    assert(descriptors[device->fd - 100]);
    _wpk_drm_owned_retire(&device->owner);free(device);
}
struct gbm_bo *gbm_bo_create(struct gbm_device *device, uint32_t width, uint32_t height,
                             uint32_t format, uint32_t flags) {
    assert(width && height && format == GBM_FORMAT_XBGR8888 && flags == GBM_BO_USE_RENDERING);
    if (fail_bo)
        return NULL;
    struct gbm_bo *bo = malloc(sizeof *bo);
    assert(bo);
    bo->device = device;
    bo->width = width;bo->height=height;bo->handle=++bo_created;bo->owner=NULL;
    assert(!_wpk_drm_owned_ioctl(device->owner,UINT32_C(0xc004fe01),&bo->handle,4,NULL,WPK_DRM_OWNED_CAPTURE_BO,&bo->owner));
    return bo;
}
void gbm_bo_destroy(struct gbm_bo *bo) {
    assert(descriptors[bo->device->fd - 100]);
    _wpk_drm_owned_retire(&bo->owner);bo_destroyed++;
    free(bo);
}
union gbm_bo_handle gbm_bo_get_handle(struct gbm_bo *bo) {
    return (union gbm_bo_handle){.u32 = bo->handle};
}
uint32_t gbm_bo_get_stride(struct gbm_bo *bo) { return bo->width * 4; }
int gbm_bo_get_fd(struct gbm_bo *bo) {
    if (fail_export)
        return -1;
    unsigned i = bo->device->fd - 100;
    assert(!exported[i]);
    exported[i] = 1;
    return 300 + i;
}

/* The protocol fixture models the documented four-slot private GBM API;
 * run-gbm-unit separately exercises the actual allocator and its device refs. */
struct gbm_surface {
    struct gbm_device *device;
    struct gbm_bo *bos[4];
    int back,pending,front,locked[4];
    uint32_t width,height;
};
struct gbm_surface *gbm_surface_create(struct gbm_device *d,uint32_t w,uint32_t h,uint32_t f,uint32_t flags) {
    struct gbm_surface *s=calloc(1,sizeof *s);assert(s);
    s->device=d;s->width=w;s->height=h;s->back=s->pending=s->front=-1;
    for(int i=0;i<2;i++)if(!(s->bos[i]=gbm_bo_create(d,w,h,f,flags))) {
        while(i)gbm_bo_destroy(s->bos[--i]);free(s);return NULL;
    }
    return s;
}
void gbm_surface_destroy(struct gbm_surface *s) {
    for(unsigned i=0;i<4;i++) {assert(!s->locked[i]);if(s->bos[i])gbm_bo_destroy(s->bos[i]);}
    free(s);
}
static void test_frame(struct gbm_surface *s,int i,struct wpk_gbm_frame *f) {
    *f=(struct wpk_gbm_frame){.fd=s->device->fd,.handle=s->bos[i]->handle,
        .width=s->width,.height=s->height,.format=GBM_FORMAT_XBGR8888,.pitch=s->width*4,.owner=s->device->owner,.bo_owner=s->bos[i]->owner};
}
int _wpk_gbm_window_acquire(const void *surface,void **lease,struct wpk_gbm_frame *frame) {
    struct gbm_surface *s=(void *)surface;assert(s->back==-1);
    s->back=0;*lease=s;test_frame(s,0,frame);return 1;
}
int _wpk_gbm_window_prepare(void *lease,struct wpk_gbm_frame *frame) {
    struct gbm_surface *s=lease;assert(s->pending==-1);
    for(int i=0;i<4;i++)if(i!=s->back && i!=s->front && !s->locked[i]) {
        if(!s->bos[i])s->bos[i]=gbm_bo_create(s->device,s->width,s->height,GBM_FORMAT_XBGR8888,GBM_BO_USE_RENDERING);
        if(!s->bos[i]) {errno=ENOMEM;return 0;}
        s->pending=i;test_frame(s,i,frame);return 1;
    }
    errno=EBUSY;return 0;
}
void _wpk_gbm_window_finish(void *lease,int accepted) {
    struct gbm_surface *s=lease;
    if(s->pending>=0) {if(accepted)s->front=s->pending;s->pending=-1;}
}
void _wpk_gbm_window_release(void *lease) {
    struct gbm_surface *s=lease;assert(s->pending==-1);s->back=-1;
}
struct gbm_bo *gbm_surface_lock_front_buffer(struct gbm_surface *s) {
    assert(s->front>=0 && !s->locked[s->front]);
    struct gbm_bo *bo=s->bos[s->front];s->locked[s->front]=1;s->front=-1;return bo;
}
void gbm_surface_release_buffer(struct gbm_surface *s,struct gbm_bo *bo) {
    for(int i=0;i<4;i++)if(s->bos[i]==bo) {assert(s->locked[i]);s->locked[i]=0;return;}
    assert(!"foreign GBM front release");
}

const struct wl_interface wl_registry_interface = {.name = "wl_registry", .version = 1};
const struct wl_interface wl_buffer_interface = {.name = "wl_buffer", .version = 1};
const struct wl_interface zwp_linux_dmabuf_v1_interface = {.name = "zwp_linux_dmabuf_v1",
                                                           .version = 3};
const struct wl_interface zwp_linux_buffer_params_v1_interface = {
    .name = "zwp_linux_buffer_params_v1", .version = 1};
static int proxies[256];
static const struct wl_buffer_listener *buffer_callbacks[256];
static void *buffer_data[256];
static unsigned buffer_proxies[256],dispatches;
static int release_on_dispatch=-1,disconnect_on_dispatch,fail_dispatch,present_count,fail_present,fail_listener;
static struct wl_buffer *last_presented;
static void release_buffer(unsigned i) {
    assert(buffer_proxies[i] && buffer_callbacks[i]);buffer_callbacks[i]->release(buffer_data[i],(void *)&proxies[i]);
}
static unsigned next_proxy;
static struct wl_proxy *registry_proxy;
static const struct wl_registry_listener *registry_callbacks;
static void *registry_data;
static unsigned roundtrips,fail_roundtrip;
struct wl_proxy *wl_proxy_marshal_flags(struct wl_proxy *proxy, uint32_t opcode,
                                        const struct wl_interface *interface, uint32_t version,
                                        uint32_t flags, ...) {
    assert(proxy);
    (void)opcode;
    (void)version;
    if (flags & WL_MARSHAL_FLAG_DESTROY) {wl_proxy_destroy(proxy);return NULL;}
    if (!interface)
        return NULL;
    if (interface == &zwp_linux_buffer_params_v1_interface && fail_params)
        return NULL;
    if (interface == &wl_buffer_interface) {
        va_list args;va_start(args,flags);
        (void)va_arg(args,void *);(void)va_arg(args,int);(void)va_arg(args,int);
        (void)va_arg(args,unsigned);
        unsigned buffer_flags=va_arg(args,unsigned);va_end(args);
        assert(buffer_flags==0 && "ordinary Wayland dma-bufs must be top-row-first");
    }
    if (interface == &wl_buffer_interface && fail_buffer)
        return NULL;
    assert(next_proxy < 256);
    struct wl_proxy *result=(struct wl_proxy *)&proxies[next_proxy++];
    if(interface==&wl_registry_interface)registry_proxy=result;
    if(interface==&wl_buffer_interface){buffer_proxies[next_proxy-1]=1;if(window_log_on_buffer)window_native_log();}
    return result;
}
uint32_t wl_proxy_get_version(struct wl_proxy *proxy) {
    (void)proxy;
    return 3;
}
void wl_proxy_destroy(struct wl_proxy *proxy) {window_native_destroys++;unsigned i=(int *)proxy-proxies;buffer_callbacks[i]=NULL;buffer_data[i]=NULL;if(!window_log_on_buffer)window_native_log();}
void wl_proxy_set_queue(struct wl_proxy *proxy, struct wl_event_queue *queue) {
    (void)proxy;
    (void)queue;
}
int wl_proxy_add_listener(struct wl_proxy *proxy, void (**listener)(void), void *data) {
    if(proxy==registry_proxy) {registry_callbacks=(const struct wl_registry_listener *)listener;registry_data=data;}
    else {unsigned i=(int *)proxy-proxies;if(buffer_proxies[i]) {if(fail_listener)return -1;buffer_callbacks[i]=(void *)listener;buffer_data[i]=data;}}
    return 0;
}
struct wl_display *wl_proxy_get_display(struct wl_proxy *proxy) {
    return (struct wl_display *)proxy;
}
struct wl_event_queue *wl_display_create_queue(struct wl_display *display) {
    return (struct wl_event_queue *)display;
}
void wl_event_queue_destroy(struct wl_event_queue *queue) { (void)queue; }
/* These native proxies contain local bookkeeping only; inherited cleanup
 * must not marshal a destructor to the parent's protocol connection. */
void _wpk_wl_proxy_discard_inherited(void *hold,void *proxy){(void)hold;wl_proxy_destroy(proxy);}
void _wpk_wl_queue_discard_inherited(void *hold,void *queue){(void)hold;wl_event_queue_destroy(queue);}
int wl_display_roundtrip_queue(struct wl_display *display, struct wl_event_queue *queue) {
    (void)display;(void)queue;
    if(registry_callbacks) {
        const struct wl_registry_listener *listener=registry_callbacks;registry_callbacks=NULL;
        listener->global(registry_data,(struct wl_registry *)registry_proxy,1,"zwp_linux_dmabuf_v1",3);
    }
    return ++roundtrips==fail_roundtrip ? -1 : 0;
}
static int surface_live=1;
int wl_display_dispatch_queue(struct wl_display *display,struct wl_event_queue *queue) {
    assert(display==(void *)&proxies[125] && queue==(void *)display);dispatches++;
    if(disconnect_on_dispatch) {surface_live=0;return -1;}
    if(fail_dispatch)return -1;
    assert(release_on_dispatch>=0);release_buffer((unsigned)release_on_dispatch);release_on_dispatch=-1;if(window_log_on_dispatch)window_native_log();return 0;
}
static unsigned surface_holds;
static uint64_t surface_identity=1;
void *_wpk_wl_surface_acquire(const void *surface,const void **display,uint64_t *identity) {
    if(surface!=&proxies[126] || !surface_live)return NULL;
    *display=&proxies[125];*identity=surface_identity;surface_holds++;if(window_acquire_phase)window_acquire_phase();return &surface_holds;
}
int _wpk_wl_surface_alive(void *hold) {assert(hold==&surface_holds && surface_holds);return surface_live;}
int _wpk_wl_surface_present(void *hold,void *buffer,int width,int height) {
    assert(hold==&surface_holds && surface_holds && buffer && width>0 && height>0);
    last_presented=buffer;present_count++;
    if(window_log_on_present&&window_present_hook){window_native_hook=window_present_hook;window_present_hook=NULL;window_native_log();}
    return surface_live && !fail_present;
}
void _wpk_wl_surface_release(void *hold) {assert(hold==&surface_holds && surface_holds);surface_holds--;}
void _wpk_wl_surface_release_inherited(void *hold){_wpk_wl_surface_release(hold);}
int _wpk_egl_window_retarget(void *window) {
    assert(_wpk_wlegl_device_fd(window) >= 100 && _wpk_wlegl_bo_handle(window));
    struct wpk_wlegl *w=((struct wl_egl_window *)window)->driver_private;
    if(w->references){
        struct wpk_wlegl_frame frame;
        if(!_wpk_wlegl_prepare(w,&frame)){window_retarget_error=70;return 0;}
        if(!_wpk_wlegl_finish(w,0)){window_retarget_error=71;return 0;}
    }
    if(destroy_during_retarget)wl_egl_window_destroy(window);
    if(window_exit_retarget)pthread_exit(NULL);
    return !reject_retarget;
}

/* Pending leaves are protocol doubles here; their actual native Wayland and
 * GBM implementations have separate causal actor suites. This fixture keeps
 * the window/allocation owner under test, not an alternate product path. */
uint64_t __wasm_posix_native_fork_epoch(void){return window_native_epoch;}
int _wpk_wl_surface_boundary_required(void *hold){assert(hold==&surface_holds);window_boundary_queries++;return window_boundary_required;}
int _wpk_wl_surface_acquire_pending(const void *surface,const void **display,uint64_t *identity,void **receiver){
    assert(receiver&&!*receiver);if(surface!=&proxies[126]||!surface_live)return 0;
    _wpk_drm_owned_publication_begin();*receiver=&surface_holds;*display=&proxies[125];*identity=surface_identity;surface_holds++;_wpk_drm_owned_publication_end();
    if(window_acquire_phase)window_acquire_phase();return 1;
}
struct wpk_wl_log_message {
    struct wpk_wl_log_message *next;
    void (*callback)(void);
    struct wpk_drm_actor_claim claim;
    int started;
};
static _Thread_local struct wpk_wl_log_scope *window_capture;
static void window_native_log(void){
    void (*callback)(void)=window_native_hook;if(!callback)return;window_native_hook=NULL;
    if(!window_capture&&window_resolver){window_resolver_calls++;window_resolved_scope=window_resolver();if(window_resolved_scope)assert(_wpk_wl_log_capture_begin(window_resolved_scope));}
    if(!window_capture){callback();return;}
    struct wpk_wl_log_message *m=calloc(1,sizeof *m);assert(m);m->callback=callback;
    _wpk_drm_owned_publication_begin();if(!window_capture->origin_claim.scope)assert(_wpk_drm_actor_try_claim_locked(&window_capture->origin_claim));if(window_capture->tail)window_capture->tail->next=m;else window_capture->messages=m;window_capture->tail=m;_wpk_drm_owned_publication_end();
}
int _wpk_wl_log_set_resolver(wpk_wl_log_resolver resolver){if(window_resolver&&window_resolver!=resolver){errno=EBUSY;return 0;}window_resolver=resolver;return 1;}
int _wpk_wl_log_capture_begin(struct wpk_wl_log_scope *s){
    window_capture_count++;
    if(!_wpk_drm_actor_prepare())return 0;_wpk_drm_owned_publication_begin();
    if(s->capturing||s->messages||!_wpk_drm_actor_try_claim_locked(&s->capture_claim)){_wpk_drm_owned_publication_end();return 0;}
    s->previous=window_capture;window_capture=s;s->capturing=1;_wpk_drm_owned_publication_end();return 1;
}
void _wpk_wl_log_capture_end_locked(struct wpk_wl_log_scope *s){assert(s->capturing&&window_capture==s);window_capture=s->previous;s->previous=NULL;s->capturing=0;_wpk_drm_actor_release_locked(&s->capture_claim);}
void _wpk_wl_log_capture_end(struct wpk_wl_log_scope *s){_wpk_drm_owned_publication_begin();_wpk_wl_log_capture_end_locked(s);_wpk_drm_owned_publication_end();}
int _wpk_wl_log_deliver(struct wpk_wl_log_scope *s){
    if(!_wpk_drm_actor_prepare()||s->capturing)return 0;
    _wpk_drm_owned_publication_begin();
    if(_wpk_drm_actor_claim_live_locked(&s->origin_claim)&&!_wpk_drm_actor_claim_current_locked(&s->origin_claim)){_wpk_drm_owned_publication_end();return 0;}
    if(s->messages&&!_wpk_drm_actor_claim_live_locked(&s->origin_claim))assert(_wpk_drm_actor_try_claim_locked(&s->origin_claim));
    _wpk_drm_owned_publication_end();
    if(window_capture&&window_capture!=s){
        _wpk_drm_owned_publication_begin();
        if(s->messages){if(!window_capture->origin_claim.scope)assert(_wpk_drm_actor_try_claim_locked(&window_capture->origin_claim));if(window_capture->tail)window_capture->tail->next=s->messages;else window_capture->messages=s->messages;window_capture->tail=s->tail;s->messages=s->tail=NULL;}_wpk_drm_actor_release_locked(&s->origin_claim);
        _wpk_drm_owned_publication_end();return 1;
    }
    while(s->messages){
        _wpk_drm_owned_publication_begin();struct wpk_wl_log_message *m=s->messages;
        if(!_wpk_drm_actor_try_claim_locked(&m->claim)){_wpk_drm_owned_publication_end();return 0;}
        int invoke=!m->started;m->started=1;_wpk_drm_owned_publication_end();
        if(invoke){struct wpk_wl_log_scope *prior=window_capture;window_capture=NULL;m->callback();window_capture=prior;}
        _wpk_drm_owned_publication_begin();assert(s->messages==m);s->messages=m->next;if(s->tail==m)s->tail=NULL;_wpk_drm_actor_release_locked(&m->claim);free(m);_wpk_drm_owned_publication_end();
    }_wpk_drm_owned_publication_begin();_wpk_drm_actor_release_locked(&s->origin_claim);_wpk_drm_owned_publication_end();return 1;
}
#if defined(WPK_WAYLAND_WINDOW_BEFORE) && !defined(WPK_WAYLAND_WINDOW_BEFORE_HAS_DRAIN)
int _wpk_wlegl_drain_deferred(void){return 0;}
#endif
void _wpk_egl_request_native_drain(void){
    window_requested=1;
}
struct window_deferred_logs {struct window_deferred_logs *next;struct wpk_wl_log_scope logs;struct wpk_drm_actor_claim actor;};
static struct window_deferred_logs *window_deferred;
int _wpk_wl_log_defer(struct wpk_wl_log_scope *s){
    assert(!s->capturing);if(!s->messages)return 1;
    struct window_deferred_logs *o=calloc(1,sizeof *o);assert(o);
    _wpk_drm_owned_publication_begin();o->logs.messages=s->messages;o->logs.tail=s->tail;o->logs.origin_claim=s->origin_claim;s->messages=s->tail=NULL;s->origin_claim.scope=NULL;struct window_deferred_logs **tail=&window_deferred;while(*tail)tail=&(*tail)->next;*tail=o;_wpk_drm_owned_publication_end();
    _wpk_egl_request_native_drain();return 1;
}
int _wpk_wl_log_drain_deferred(void){
    if(!_wpk_drm_actor_prepare())return 0;int rearm=0;
    for(;;){
        _wpk_drm_owned_publication_begin();struct window_deferred_logs *o=NULL;
        for(struct window_deferred_logs *p=window_deferred;p;p=p->next){
            if(_wpk_drm_actor_claim_live_locked(&p->logs.origin_claim)&&!_wpk_drm_actor_claim_current_locked(&p->logs.origin_claim)){rearm=1;continue;}
            if(_wpk_drm_actor_try_claim_locked(&p->actor)){o=p;break;}
        }
        _wpk_drm_owned_publication_end();if(!o)break;
        int complete=_wpk_wl_log_deliver(&o->logs);
        _wpk_drm_owned_publication_begin();_wpk_drm_actor_release_locked(&o->actor);
        if(complete){struct window_deferred_logs **p=&window_deferred;while(*p&&*p!=o)p=&(*p)->next;assert(*p);*p=o->next;free(o);}
        _wpk_drm_owned_publication_end();if(!complete)break;
    }return rearm;
}
enum wpk_wl_retire_result _wpk_wl_proxy_destroy_pending(struct wpk_wl_proxy_retirement *s,uint32_t opcode){
    (void)opcode;if(s->live){
        if(window_leaf_defer_once){window_leaf_defer_once=0;return WPK_WL_RETIRE_PENDING;}
        if(!_wpk_wl_log_capture_begin(&s->logs))return WPK_WL_RETIRE_PENDING;
        if(!window_local_destroy)window_protocol_destroys++;
        wl_proxy_destroy(s->live);_wpk_drm_owned_publication_begin();s->live=NULL;_wpk_wl_log_capture_end_locked(&s->logs);_wpk_drm_owned_publication_end();
    }return _wpk_wl_log_deliver(&s->logs)?WPK_WL_RETIRE_COMPLETE:WPK_WL_RETIRE_PENDING;
}
enum wpk_wl_retire_result _wpk_wl_proxy_destroy_local_pending(struct wpk_wl_proxy_retirement *s){int prior=window_local_destroy;window_local_destroy=1;enum wpk_wl_retire_result r=_wpk_wl_proxy_destroy_pending(s,0);window_local_destroy=prior;return r;}
enum wpk_wl_retire_result _wpk_wl_proxy_discard_pending(struct wpk_wl_proxy_retirement *s){return _wpk_wl_proxy_destroy_local_pending(s);}
int _wpk_wl_private_queue_register(struct wpk_wl_private_queue_token *token,void *queue,void *hold,void *owner,struct wpk_drm_actor_claim *claim,struct wpk_wl_log_scope *logs){
    assert(queue&&hold==&surface_holds&&surface_holds&&owner&&logs&&!token->active);
    _wpk_drm_owned_publication_begin();assert(_wpk_drm_actor_claim_current_locked(claim));
    token->queue=queue;token->connection=hold;token->owner=owner;token->owner_claim=claim;token->owner_logs=logs;token->active=1;
    _wpk_drm_owned_publication_end();return 1;
}
void _wpk_wl_private_queue_withdraw_locked(struct wpk_wl_private_queue_token *token){memset(token,0,sizeof *token);}
void _wpk_wl_private_queue_withdraw(struct wpk_wl_private_queue_token *token){_wpk_drm_owned_publication_begin();_wpk_wl_private_queue_withdraw_locked(token);_wpk_drm_owned_publication_end();}
enum wpk_wl_retire_result _wpk_wl_queue_destroy_pending(struct wpk_wl_queue_retirement *s){
    if(s->live){wl_event_queue_destroy(s->live);s->live=NULL;}return WPK_WL_RETIRE_COMPLETE;
}
enum wpk_wl_retire_result _wpk_wl_queue_discard_pending(struct wpk_wl_queue_retirement *s){return _wpk_wl_queue_destroy_pending(s);}
enum wpk_wl_retire_result _wpk_wl_surface_release_pending(struct wpk_wl_surface_retirement *s){
    if(s->live){_wpk_wl_surface_release(s->live);s->live=NULL;}return WPK_WL_RETIRE_COMPLETE;
}
int _wpk_gbm_surface_release_buffer_pending(struct wpk_gbm_front_hold *s){
    if(s->bo){_wpk_drm_owned_publication_begin();gbm_surface_release_buffer(s->surface,s->bo);s->surface=NULL;s->bo=NULL;_wpk_drm_owned_publication_end();}return 0;
}
void _wpk_gbm_window_release_pending(struct wpk_gbm_window_retirement *s){if(s->live){_wpk_gbm_window_release(s->live);s->live=NULL;}}
void _wpk_gbm_surface_destroy_pending(struct wpk_gbm_window_retirement *s){if(s->live){gbm_surface_destroy(s->live);s->live=NULL;}}
void _wpk_gbm_device_destroy_pending(struct gbm_device **s){if(*s){gbm_device_destroy(*s);*s=NULL;}}

#ifndef WPK_WAYLAND_WINDOW_MAIN
#define WPK_WAYLAND_WINDOW_MAIN main
#endif
int WPK_WAYLAND_WINDOW_MAIN(void) {
    for(unsigned failure=1;failure<=2;failure++) {
        roundtrips=0;fail_roundtrip=failure;
        assert(!wl_egl_window_create((void *)&proxies[126],32,24));
        assert(surface_holds==0 && opens==closed);
    }
    fail_roundtrip=0;
    fail_params=1;
    assert(!wl_egl_window_create((void *)&proxies[126],32,24));
    assert(surface_holds==0 && opens==closed && bo_created==bo_destroyed);
    for(unsigned i=0;i<16;i++)assert(!descriptors[i] && !exported[i]);
    fail_params=0;
    struct wl_egl_window *native=wl_egl_window_create((void *)&proxies[126],32,24);
    assert(native && surface_holds==1);
    struct wpk_wlegl *owned=native->driver_private;
    void *lease=NULL;struct wpk_wlegl_frame frame;
    assert(!_wpk_wlegl_acquire((void *)1,&proxies[125],surface_identity,&lease,&frame));
    assert(!_wpk_wlegl_acquire(native,&proxies[125],surface_identity+1,&lease,&frame));
    assert(_wpk_wlegl_acquire(native,&proxies[125],surface_identity,&lease,&frame));
    assert(_wpk_wlegl_finish(lease,0));
#define backend (*owned)
#define window (*native)
    assert(descriptors[0] && opens==closed+1);
    assert(_wpk_wlegl_device_fd(&window) == 100 && _wpk_wlegl_bo_handle(&window) == frame.handle);
    assert(_wpk_wlegl_prepare_present(lease,&frame));assert(_wpk_wlegl_finish(lease,1));
    unsigned retired_front_index=(int *)last_presented-proxies;
    wl_egl_window_resize(&window, 80, 48, 0, 0);
    assert(descriptors[0] && descriptors[1] && backend.retired && window.attached_width == 80);
    // A release queued before resize still names the old stable allocation.
    release_buffer(retired_front_index);
    assert(backend.retired && !backend.retired->fronts[0].busy);
    reject_retarget = 1;
    wl_egl_window_resize(&window, 96, 64, 0, 0);
    reject_retarget = 0;
    assert(_wpk_wlegl_device_fd(&window) == 101 && window.attached_width == 80);
    assert(!descriptors[0] && descriptors[1] && !descriptors[2]);
    for (int failure = 0; failure < 5; failure++) {
        fail_device = failure == 0;
        fail_bo = failure == 1;
        fail_export = failure == 2;
        fail_params = failure == 3;
        fail_buffer = failure == 4;
        wl_egl_window_resize(&window, 96, 64, 0, 0);
        assert(_wpk_wlegl_device_fd(&window) == 101 && window.attached_width == 80 &&
               descriptors[1]);
        for(unsigned i=0;i<16;i++)assert(!exported[i]);
    }
    fail_device = fail_bo = fail_export = fail_params = fail_buffer = 0;
    wl_egl_window_resize(&window, 96, 64, 0, 0);
    assert(window.attached_width == 96 && backend.retired && descriptors[1]);
    assert(_wpk_wlegl_prepare_present(lease,&frame));assert(_wpk_wlegl_finish(lease,1));
    assert(!backend.retired && !descriptors[1]);
    surface_live=0;
    assert(!_wpk_wlegl_prepare(lease,&frame));
    wl_egl_window_destroy(native);
    assert(_wpk_wlegl_bo_handle(native)==0 && _wpk_wlegl_device_fd(native)==-1);
    assert(!_wpk_wlegl_dimensions((void *)1,&frame.width,&frame.height));
    assert(surface_holds==1 && bo_created>bo_destroyed);
    wl_egl_window_destroy(native); // revoked raw pointer is never dereferenced
    _wpk_wlegl_release(lease);
    assert(surface_holds==0);
    surface_live=1;surface_identity++;
    native=wl_egl_window_create((void *)&proxies[126],16,16);assert(native);
    assert(!_wpk_wlegl_acquire(native,&proxies[125],surface_identity-1,&lease,&frame));
    assert(_wpk_wlegl_acquire(native,&proxies[125],surface_identity,&lease,&frame));
    assert(_wpk_wlegl_finish(lease,0));
    assert(_wpk_wlegl_prepare_present(lease,&frame));assert(_wpk_wlegl_finish(lease,1));
    _wpk_wlegl_release(lease);wl_egl_window_destroy(native);
    assert(surface_holds==0);
    // Reentrant public destruction during an EGL retarget cannot free the
    // allocation being resized or restore a revoked owner on rollback.
    for(int rejected=0;rejected<2;rejected++) {
        native=wl_egl_window_create((void *)&proxies[126],16,16);assert(native);
        assert(_wpk_wlegl_acquire(native,&proxies[125],surface_identity,&lease,&frame));
        assert(_wpk_wlegl_finish(lease,0));
        destroy_during_retarget=1;reject_retarget=rejected;
        wl_egl_window_resize(native,24,24,0,0);
        destroy_during_retarget=reject_retarget=0;
        assert(_wpk_wlegl_device_fd(native)==-1 && !_wpk_wlegl_prepare(lease,&frame));
        assert(surface_holds==1);
        _wpk_wlegl_release(lease);assert(surface_holds==0);
    }
    // Three compositor-busy fronts are distinct from the private back. The
    // fourth swap dispatches only the private queue and reuses exactly the
    // front whose release has been received. Aborted copies publish nothing.
    native=wl_egl_window_create((void *)&proxies[126],16,16);assert(native);
    assert(_wpk_wlegl_acquire(native,&proxies[125],surface_identity,&lease,&frame));
    uint32_t back=frame.handle;assert(_wpk_wlegl_finish(lease,0));
    unsigned front_indices[3];uint32_t front_handles[3];
    for(unsigned i=0;i<3;i++) {
        if(i==1) {
            // Lazy allocation and first-proxy failures return the candidate
            // without losing any already accepted compositor front.
            fail_bo=1;assert(!_wpk_wlegl_prepare_present(lease,&frame));fail_bo=0;
            for(unsigned failure=0;failure<4;failure++) {
                assert(_wpk_wlegl_prepare_present(lease,&frame));
                fail_export=failure==0;fail_params=failure==1;fail_buffer=failure==2;fail_listener=failure==3;
                int before=present_count;assert(!_wpk_wlegl_finish(lease,1));
                assert(present_count==before && !((struct wpk_wlegl *)native->driver_private)->active);
                for(unsigned j=0;j<16;j++)assert(!exported[j]);
                fail_export=fail_params=fail_buffer=fail_listener=0;
            }
        }
        assert(_wpk_wlegl_prepare_present(lease,&frame));front_handles[i]=frame.handle;
        assert(frame.handle!=back);
        for(unsigned j=0;j<i;j++)assert(frame.handle!=front_handles[j]);
        assert(_wpk_wlegl_finish(lease,1));front_indices[i]=(int *)last_presented-proxies;
    }
    unsigned old_dispatches=dispatches;release_on_dispatch=(int)front_indices[1];
    assert(_wpk_wlegl_prepare_present(lease,&frame) && frame.handle==front_handles[1]);
    assert(dispatches==old_dispatches+1);
    int before_present=present_count;
    assert(_wpk_wlegl_finish(lease,0) && present_count==before_present);
    assert(_wpk_wlegl_prepare_present(lease,&frame) && frame.handle==front_handles[1]);
    assert(_wpk_wlegl_finish(lease,1));
    // A potentially accepted failed commit keeps its front busy. It cannot
    // be recycled until an actual release or the whole window retires.
    release_buffer(front_indices[0]);
    assert(_wpk_wlegl_prepare_present(lease,&frame));fail_present=1;
    assert(!_wpk_wlegl_finish(lease,1));fail_present=0;
    fail_dispatch=1;assert(!_wpk_wlegl_prepare_present(lease,&frame));fail_dispatch=0;
    assert(!_wpk_wlegl_finish(lease,0)); // failed admission released active
    // Disconnect wakes private-queue backpressure and rejects further swaps.
    disconnect_on_dispatch=1;assert(!_wpk_wlegl_prepare_present(lease,&frame));
    assert(!_wpk_wlegl_prepare_present(lease,&frame));disconnect_on_dispatch=0;
    wl_egl_window_destroy(native);_wpk_wlegl_release(lease);surface_live=1;
    assert(opens == closed && bo_created == bo_destroyed);
    for (unsigned i = 0; i < 16; i++)
        assert(!descriptors[i] && !exported[i]);
    puts("PASS wayland-window descriptor ownership and resize rollback");
    return 0;
}
