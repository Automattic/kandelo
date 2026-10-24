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
static int descriptors[16], exported[16], fail_device, fail_bo, fail_export, fail_buffer,
    reject_retarget;
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
struct wl_proxy *wl_proxy_marshal_flags(struct wl_proxy *proxy, uint32_t opcode,
                                        const struct wl_interface *interface, uint32_t version,
                                        uint32_t flags, ...) {
    (void)proxy;
    (void)opcode;
    (void)version;
    if (flags & WL_MARSHAL_FLAG_DESTROY)
        return NULL;
    if (!interface)
        return NULL;
    if (interface == &wl_buffer_interface && fail_buffer)
        return NULL;
    assert(next_proxy < 128);
    return (struct wl_proxy *)&proxies[next_proxy++];
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
    (void)proxy;
    (void)listener;
    (void)data;
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
    (void)display;
    (void)queue;
    return 0;
}
int _wpk_egl_window_retarget(void *window) {
    assert(_wpk_wlegl_device_fd(window) >= 100 && _wpk_wlegl_bo_handle(window));
    return !reject_retarget;
}

int main(void) {
    struct wpk_wlegl backend = {.dmabuf = (void *)&proxies[127]};
    struct wl_egl_window window = {.width = 32,
                                   .height = 24,
                                   .attached_width = 32,
                                   .attached_height = 24,
                                   .driver_private = &backend,
                                   .surface = (void *)&proxies[126]};
    assert(!alloc_buffer(&backend, &window, 32, 24) && descriptors[0] && opens == 1);
    assert(_wpk_wlegl_device_fd(&window) == 100 && _wpk_wlegl_bo_handle(&window) == 101);
    wl_egl_window_resize(&window, 80, 48, 0, 0);
    assert(descriptors[0] && descriptors[1] && backend.retired_gbm && window.attached_width == 80);
    reject_retarget = 1;
    wl_egl_window_resize(&window, 96, 64, 0, 0);
    reject_retarget = 0;
    assert(_wpk_wlegl_device_fd(&window) == 101 && window.attached_width == 80);
    assert(!descriptors[0] && descriptors[1] && !descriptors[2]);
    for (int failure = 0; failure < 4; failure++) {
        fail_device = failure == 0;
        fail_bo = failure == 1;
        fail_export = failure == 2;
        fail_buffer = failure == 3;
        wl_egl_window_resize(&window, 96, 64, 0, 0);
        assert(_wpk_wlegl_device_fd(&window) == 101 && window.attached_width == 80 &&
               descriptors[1]);
    }
    fail_device = fail_bo = fail_export = fail_buffer = 0;
    wl_egl_window_resize(&window, 96, 64, 0, 0);
    assert(window.attached_width == 96 && backend.retired_gbm && descriptors[1]);
    _wpk_wlegl_present(&window);
    assert(!backend.retired_gbm && !descriptors[1]);
    free_buffer(&backend);
    assert(opens == closed && bo_created == bo_destroyed);
    for (unsigned i = 0; i < 16; i++)
        assert(!descriptors[i] && !exported[i]);
    puts("PASS wayland-window descriptor ownership and resize rollback");
    return 0;
}
