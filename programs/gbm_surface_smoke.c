/*
 * Exercises the libgbm 2-BO ring (libc/glue/libgbm_stub.c):
 *  - lock_front_buffer hands out distinct BOs in turn,
 *  - lock-when-both-in-use returns NULL+EBUSY,
 *  - release_buffer marks the slot free again,
 *  - has_free_buffers reports the remaining-free count,
 *  - destroy with locked BOs unwinds cleanly.
 */
#include <errno.h>
#include <fcntl.h>
#include <gbm.h>
#include <stdio.h>
#include <unistd.h>

int main(void)
{
    int fd = open("/dev/dri/card0", O_RDWR);
    if (fd < 0) {
        fprintf(stderr, "FAIL: open /dev/dri/card0: %d\n", errno);
        return 1;
    }
    struct gbm_device *dev = gbm_create_device(fd);
    if (!dev) {
        fprintf(stderr, "FAIL: gbm_create_device\n");
        close(fd);
        return 1;
    }
    struct gbm_surface *s = gbm_surface_create(
        dev, 320, 240, GBM_FORMAT_XRGB8888,
        GBM_BO_USE_SCANOUT | GBM_BO_USE_RENDERING);
    if (!s) {
        fprintf(stderr, "FAIL: gbm_surface_create: %d\n", errno);
        gbm_device_destroy(dev);
        close(fd);
        return 1;
    }

    int free_before = gbm_surface_has_free_buffers(s);
    if (free_before != 2) {
        fprintf(stderr, "FAIL: expected 2 free BOs, got %d\n", free_before);
        return 1;
    }

    struct gbm_bo *bo_a = gbm_surface_lock_front_buffer(s);
    if (!bo_a) {
        fprintf(stderr, "FAIL: first lock returned NULL\n");
        return 1;
    }
    if (gbm_surface_has_free_buffers(s) != 1) {
        fprintf(stderr, "FAIL: expected 1 free after one lock\n");
        return 1;
    }

    struct gbm_bo *bo_b = gbm_surface_lock_front_buffer(s);
    if (!bo_b || bo_b == bo_a) {
        fprintf(stderr, "FAIL: second lock must return a distinct BO\n");
        return 1;
    }
    if (gbm_surface_has_free_buffers(s) != 0) {
        fprintf(stderr, "FAIL: expected 0 free after two locks\n");
        return 1;
    }

    errno = 0;
    struct gbm_bo *bo_c = gbm_surface_lock_front_buffer(s);
    if (bo_c != NULL || errno != EBUSY) {
        fprintf(stderr, "FAIL: third lock must NULL+EBUSY, got bo=%p errno=%d\n",
                (void *) bo_c, errno);
        return 1;
    }

    gbm_surface_release_buffer(s, bo_a);
    if (gbm_surface_has_free_buffers(s) != 1) {
        fprintf(stderr, "FAIL: expected 1 free after release of bo_a\n");
        return 1;
    }

    struct gbm_bo *bo_d = gbm_surface_lock_front_buffer(s);
    if (!bo_d) {
        fprintf(stderr, "FAIL: lock after release returned NULL\n");
        return 1;
    }

    gbm_surface_destroy(s);
    gbm_device_destroy(dev);
    close(fd);
    printf("OK\n");
    return 0;
}
