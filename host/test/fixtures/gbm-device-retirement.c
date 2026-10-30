#include <gbm.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdint.h>
#include <unistd.h>
extern int _wpk_gbm_device_metadata(const void *, int *, uint64_t *);
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "line %d: %s errno=%d\n", __LINE__, #x, errno); return 1; } } while (0)
int main(void) {
    int fd = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC); CHECK(fd >= 0);
    struct gbm_device *device = gbm_create_device(fd); CHECK(device);
    CHECK(gbm_device_get_fd(device) == fd);
    int retained_fd = -1; uint64_t identity = 0;
    CHECK(_wpk_gbm_device_metadata(device, &retained_fd, &identity));
    struct gbm_bo *bo = gbm_bo_create(device, 4, 3, GBM_FORMAT_ABGR8888, GBM_BO_USE_WRITE); CHECK(bo);
    struct gbm_surface *surface = gbm_surface_create(device, 4, 3, GBM_FORMAT_ABGR8888, GBM_BO_USE_WRITE);
    CHECK(surface);
    gbm_device_destroy(device);
    CHECK(close(fd) == 0);
    int replacement = open("/dev/null", O_RDWR | O_CLOEXEC); CHECK(replacement == fd);
    int prime = gbm_bo_get_fd(bo); CHECK(prime >= 0);
    CHECK(close(prime) == 0);
    unsigned color = 0xff123456;
    CHECK(gbm_bo_write(bo, &color, sizeof color) == 0);
    gbm_bo_destroy(bo);
    gbm_surface_destroy(surface);
    CHECK(fcntl(replacement, F_GETFD) >= 0);
    CHECK(close(replacement) == 0);
    CHECK(fcntl(retained_fd, F_GETFD) == -1 && errno == EBADF);
    puts("OK GBM buffers retain their retired device file");
    return 0;
}
