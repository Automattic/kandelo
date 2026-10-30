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
    uint32_t width;
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
    bo->width = width;
    bo_created++;
    return bo;
}
void gbm_bo_destroy(struct gbm_bo *bo) {
    assert(descriptors[bo->device->fd - 100]);
    bo_destroyed++;
    free(bo);
}
union gbm_bo_handle gbm_bo_get_handle(struct gbm_bo *bo) {
    return (union gbm_bo_handle){.u32 = (uint32_t)bo->device->fd + 1};
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

const struct wl_interface wl_registry_interface = {.name = "wl_registry", .version = 1};
const struct wl_interface wl_buffer_interface = {.name = "wl_buffer", .version = 1};
const struct wl_interface zwp_linux_dmabuf_v1_interface = {.name = "zwp_linux_dmabuf_v1",
                                                           .version = 3};
const struct wl_interface zwp_linux_buffer_params_v1_interface = {
    .name = "zwp_linux_buffer_params_v1", .version = 1};
static int proxies[128];
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
    if (flags & WL_MARSHAL_FLAG_DESTROY)
        return NULL;
    if (!interface)
        return NULL;
    if (interface == &zwp_linux_buffer_params_v1_interface && fail_params)
        return NULL;
    if (interface == &wl_buffer_interface && fail_buffer)
        return NULL;
    assert(next_proxy < 128);
    struct wl_proxy *result=(struct wl_proxy *)&proxies[next_proxy++];
    if(interface==&wl_registry_interface)registry_proxy=result;
    return result;
}
uint32_t wl_proxy_get_version(struct wl_proxy *proxy) {
    (void)proxy;
    return 3;
}
void wl_proxy_destroy(struct wl_proxy *proxy) { (void)proxy; }
void wl_proxy_set_queue(struct wl_proxy *proxy, struct wl_event_queue *queue) {
    (void)proxy;
    (void)queue;
}
int wl_proxy_add_listener(struct wl_proxy *proxy, void (**listener)(void), void *data) {
    if(proxy==registry_proxy) {registry_callbacks=(const struct wl_registry_listener *)listener;registry_data=data;}
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
static unsigned surface_holds;
static uint64_t surface_identity=1;
void *_wpk_wl_surface_acquire(const void *surface,const void **display,uint64_t *identity) {
    if(surface!=&proxies[126] || !surface_live)return NULL;
    *display=&proxies[125];*identity=surface_identity;surface_holds++;return &surface_holds;
}
int _wpk_wl_surface_alive(void *hold) {assert(hold==&surface_holds && surface_holds);return surface_live;}
int _wpk_wl_surface_present(void *hold,void *buffer,int width,int height) {
    assert(hold==&surface_holds && surface_holds && buffer && width>0 && height>0);return surface_live;
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
    assert(_wpk_wlegl_device_fd(&window) == 100 && _wpk_wlegl_bo_handle(&window) == 101);
    wl_egl_window_resize(&window, 80, 48, 0, 0);
    assert(descriptors[0] && descriptors[1] && backend.retired_gbm && window.attached_width == 80);
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
    assert(window.attached_width == 96 && backend.retired_gbm && descriptors[1]);
    _wpk_wlegl_present(&window);
    assert(!backend.retired_gbm && !descriptors[1]);
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
    assert(_wpk_wlegl_finish(lease,1));_wpk_wlegl_release(lease);wl_egl_window_destroy(native);
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
    assert(opens == closed && bo_created == bo_destroyed);
    for (unsigned i = 0; i < 16; i++)
        assert(!descriptors[i] && !exported[i]);
    puts("PASS wayland-window descriptor ownership and resize rollback");
    return 0;
}
