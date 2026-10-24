/* Actual GBM source with a DRM allocation double: this tests the native
 * window registry, not kernel allocation or pixel rendering. */
#include <gbm.h>
#include <xf86drm.h>
#include <drm/drm_mode.h>
#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/mman.h>
#include <unistd.h>

int _wpk_gbm_surface_metadata(const void *, uint32_t *, uint32_t *, uint32_t *, uint32_t *);
int _wpk_gbm_surface_dimensions(const void *, uint32_t *, uint32_t *);
static unsigned created, closed, fail_allocation;
int drmIoctl(int fd, unsigned long request, void *data) {
    assert(fd == 17);
    if (request == DRM_IOCTL_MODE_CREATE_DUMB) {
        if (fail_allocation && created+1 == fail_allocation) { errno = ENOMEM; return -1; }
        struct drm_mode_create_dumb *d = data;
        d->handle = ++created; d->pitch = d->width*4; d->size = (uint64_t)d->pitch*d->height;
        return 0;
    }
    errno = ENOSYS; return -1;
}
int drmCloseBufferHandle(int fd, uint32_t handle) {
    assert(fd == 17 && handle && handle <= created); closed++; return 0;
}
static void rejected(const void *pointer) {
    uint32_t width=101,height=102,format=103,flags=104;
    assert(!_wpk_gbm_surface_metadata(pointer,&width,&height,&format,&flags));
    assert(width == 101 && height == 102 && format == 103 && flags == 104);
    assert(!_wpk_gbm_surface_dimensions(pointer,&width,&height));
    assert(width == 101 && height == 102);
}
int main(void) {
    struct gbm_device *device = gbm_create_device(17); assert(device);
    rejected(NULL); rejected((void *)(uintptr_t)1); rejected(device);
    size_t page = (size_t)sysconf(_SC_PAGESIZE);
    void *guard = mmap(NULL,page,PROT_NONE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0); assert(guard != MAP_FAILED);
    rejected(guard); assert(!munmap(guard,page));
    struct gbm_surface *first = gbm_surface_create(device,32,24,GBM_FORMAT_ABGR8888,GBM_BO_USE_RENDERING);
    struct gbm_surface *second = gbm_surface_create(device,17,9,GBM_FORMAT_XRGB8888,GBM_BO_USE_SCANOUT);
    assert(first && second);
    uint32_t width=0,height=0,format=0,flags=0;
    assert(_wpk_gbm_surface_metadata(first,&width,&height,&format,&flags));
    assert(width == 32 && height == 24 && format == GBM_FORMAT_ABGR8888 && flags == GBM_BO_USE_RENDERING);
    assert(_wpk_gbm_surface_metadata(second,&width,&height,&format,&flags));
    assert(width == 17 && height == 9 && format == GBM_FORMAT_XRGB8888 && flags == GBM_BO_USE_SCANOUT);
    assert(_wpk_gbm_surface_dimensions(first,&width,&height) && width == 32 && height == 24);
    uintptr_t retired = (uintptr_t)first;
    gbm_surface_destroy(first); rejected((void *)retired);
    assert(_wpk_gbm_surface_metadata(second,&width,&height,&format,&flags) && width == 17);
    gbm_surface_destroy(second); rejected((void *)retired);
    assert(created == 4 && closed == 4);
    fail_allocation = created+2;
    assert(!gbm_surface_create(device,3,2,GBM_FORMAT_ABGR8888,GBM_BO_USE_SCANOUT));
    assert(created == 5 && closed == 5 && errno == ENOMEM);
    rejected((void *)retired);
    gbm_device_destroy(device);
    puts("PASS actual GBM live, foreign, guarded, retired and failed-creation metadata");
}
