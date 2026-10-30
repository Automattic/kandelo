/* Reimporting one dma-buf on a DRM file reuses its GEM handle. Each
 * public GBM object must retain that handle until its own retirement. */
#include <gbm.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "line %d: %s errno=%d\n", __LINE__, #x, errno); return 1; } } while (0)
int main(void) {
    int fd = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC); CHECK(fd >= 0);
    struct gbm_device *device = gbm_create_device(fd); CHECK(device);
    struct gbm_bo *source = gbm_bo_create(device, 4, 3, GBM_FORMAT_ABGR8888, GBM_BO_USE_WRITE); CHECK(source);
    int prime = gbm_bo_get_fd(source); CHECK(prime >= 0);
    struct gbm_import_fd_data data = {.fd = prime, .width = 4, .height = 3,
        .stride = gbm_bo_get_stride(source), .format = GBM_FORMAT_ABGR8888};
    struct gbm_bo *first = gbm_bo_import(device, GBM_BO_IMPORT_FD, &data, 0);
    struct gbm_bo *second = gbm_bo_import(device, GBM_BO_IMPORT_FD, &data, 0);
    CHECK(first && second);
    CHECK(gbm_bo_get_handle(source).u32 == gbm_bo_get_handle(first).u32);
    CHECK(gbm_bo_get_handle(first).u32 == gbm_bo_get_handle(second).u32);
    gbm_bo_destroy(first);
    int survivor = gbm_bo_get_fd(second); CHECK(survivor >= 0); CHECK(close(survivor) == 0);
    survivor = gbm_bo_get_fd(source); CHECK(survivor >= 0); CHECK(close(survivor) == 0);
    gbm_bo_destroy(source);
    survivor = gbm_bo_get_fd(second); CHECK(survivor >= 0); CHECK(close(survivor) == 0);
    gbm_bo_destroy(second);
    CHECK(close(prime) == 0);
    gbm_device_destroy(device); CHECK(close(fd) == 0);
    puts("OK GBM reimport retains shared GEM handles");
    return 0;
}
