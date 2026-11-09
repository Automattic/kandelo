/* A surface has available storage before EGL produces its first frame, but
 * no produced front is lockable. Rendered ring/storage checks live in the
 * normal SDK gbm-rendered-ring fixture and three-engine browser tests. */
#include <errno.h>
#include <fcntl.h>
#include <gbm.h>
#include <stdio.h>
#include <unistd.h>
#define CHECK(x) do { if (!(x)) { fprintf(stderr,"FAIL: %s errno=%d\n",#x,errno); return 1; } } while (0)
int main(void) {
    int fd = open("/dev/dri/card0", O_RDWR); CHECK(fd >= 0);
    struct gbm_device *dev = gbm_create_device(fd); CHECK(dev);
    struct gbm_surface *s = gbm_surface_create(dev,320,240,GBM_FORMAT_XRGB8888,
        GBM_BO_USE_SCANOUT | GBM_BO_USE_RENDERING); CHECK(s);
    CHECK(gbm_surface_has_free_buffers(s) == 1);
    for (unsigned i=0; i<3; ++i) {
        errno = 0;
        CHECK(!gbm_surface_lock_front_buffer(s) && errno == EINVAL);
        CHECK(gbm_surface_has_free_buffers(s) == 1);
    }
    gbm_surface_release_buffer(s,NULL);
    CHECK(gbm_surface_has_free_buffers(s) == 1);
    gbm_surface_destroy(s);
    gbm_device_destroy(dev);
    CHECK(close(fd) == 0);
    puts("OK");
    return 0;
}
