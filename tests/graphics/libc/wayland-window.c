/* Actual native-window allocation/resize/retirement with device and Wayland
 * doubles. This proves descriptor ownership, not compositor integration. */
#include <assert.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static int window_open(const char *, int, ...);
static int window_close(int);
#define open window_open
#define close window_close
#include "../../../libc/glue/libwayland-egl.c"
#undef open
#undef close

struct gbm_device {
    int fd;
};
struct gbm_bo {
    struct gbm_device *device;
    uint32_t width, height, handle;
};
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
struct gbm_device *gbm_create_device(int fd) {
    assert(descriptors[fd - 100]);
    if (fail_device)
        return NULL;
    struct gbm_device *device = malloc(sizeof *device);
    assert(device);
    device->fd = fd;
    return device;
}
int gbm_device_get_fd(struct gbm_device *device) { return device->fd; }
void gbm_device_destroy(struct gbm_device *device) {
    assert(descriptors[device->fd - 100]);
    free(device);
}
struct gbm_bo *gbm_bo_create(struct gbm_device *device, uint32_t width, uint32_t height,
                             uint32_t format, uint32_t flags) {
    assert(width && height && format == GBM_FORMAT_XBGR8888 && flags == GBM_BO_USE_RENDERING);
    if (fail_bo)
        return NULL;
    struct gbm_bo *bo = malloc(sizeof *bo);
    assert(bo);
    bo->device = device;
    bo->width = width;bo->height=height;bo->handle=++bo_created;
    return bo;
}
void gbm_bo_destroy(struct gbm_bo *bo) {
    assert(descriptors[bo->device->fd - 100]);
    bo_destroyed++;
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
        .width=s->width,.height=s->height,.format=GBM_FORMAT_XBGR8888,.pitch=s->width*4};
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
    if(interface==&wl_buffer_interface)buffer_proxies[next_proxy-1]=1;
    return result;
}
uint32_t wl_proxy_get_version(struct wl_proxy *proxy) {
    (void)proxy;
    return 3;
}
void wl_proxy_destroy(struct wl_proxy *proxy) {unsigned i=(int *)proxy-proxies;buffer_callbacks[i]=NULL;buffer_data[i]=NULL;}
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
    assert(release_on_dispatch>=0);release_buffer((unsigned)release_on_dispatch);release_on_dispatch=-1;return 0;
}
static unsigned surface_holds;
static uint64_t surface_identity=1;
void *_wpk_wl_surface_acquire(const void *surface,const void **display,uint64_t *identity) {
    if(surface!=&proxies[126] || !surface_live)return NULL;
    *display=&proxies[125];*identity=surface_identity;surface_holds++;return &surface_holds;
}
int _wpk_wl_surface_alive(void *hold) {assert(hold==&surface_holds && surface_holds);return surface_live;}
int _wpk_wl_surface_present(void *hold,void *buffer,int width,int height) {
    assert(hold==&surface_holds && surface_holds && buffer && width>0 && height>0);
    last_presented=buffer;present_count++;return surface_live && !fail_present;
}
void _wpk_wl_surface_release(void *hold) {assert(hold==&surface_holds && surface_holds);surface_holds--;}
int _wpk_egl_window_retarget(void *window) {
    assert(_wpk_wlegl_device_fd(window) >= 100 && _wpk_wlegl_bo_handle(window));
    if(destroy_during_retarget)wl_egl_window_destroy(window);
    return !reject_retarget;
}

int main(void) {
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
