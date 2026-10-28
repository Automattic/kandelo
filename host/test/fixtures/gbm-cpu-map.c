/* Real SDK/DRM mapping leases; no renderer double or pixel substitution. */
#include <gbm.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "line %d: %s errno=%d\n", __LINE__, #x, errno); return 1; } } while (0)
int main(void) {
    int fd = open("/dev/dri/card0", O_RDWR | O_CLOEXEC);
    CHECK(fd >= 0);
    struct gbm_device *device = gbm_create_device(fd); CHECK(device);
    struct gbm_bo *bo = gbm_bo_create(device, 4, 3, GBM_FORMAT_ABGR8888, GBM_BO_USE_WRITE);
    struct gbm_bo *other = gbm_bo_create(device, 4, 3, GBM_FORMAT_ABGR8888, GBM_BO_USE_WRITE);
    CHECK(bo && other);
    uint32_t stride = 0; void *region_token = NULL, *whole_token = NULL;
    uint8_t *region = gbm_bo_map(bo, 1, 1, 2, 1, GBM_BO_TRANSFER_READ_WRITE, &stride, &region_token);
    CHECK(region && region_token && stride >= 16);
    uint8_t *whole = gbm_bo_map(bo, 0, 0, 4, 3, GBM_BO_TRANSFER_READ_WRITE, &stride, &whole_token);
    CHECK(whole && whole_token && whole_token != region_token && region == whole + stride + 4);
    uint32_t color = 0xff123456;
    memcpy(region, &color, 4);
    CHECK(!memcmp(whole + stride + 4, &color, 4));
    gbm_bo_unmap(bo, region_token);
    gbm_bo_unmap(other, whole_token);
    gbm_bo_unmap(bo, region_token);
    CHECK(!memcmp(whole + stride + 4, &color, 4));
    const struct { uint32_t x, y, w, h, flags; } invalid[] = {
        {0, 0, 0, 1, 0}, {0, 0, 1, 0, 0}, {3, 0, 2, 1, 0}, {0, 2, 1, 2, 0},
        {UINT32_MAX, 0, 2, 1, 0}, {0, UINT32_MAX, 1, 2, 0}, {0, 0, 1, 1, 0x80000000u},
    };
    for (unsigned i = 0; i < sizeof(invalid) / sizeof(invalid[0]); ++i) {
        uint32_t pitch = 101; void *token = (void *)(uintptr_t)102; errno = 0;
        CHECK(!gbm_bo_map(bo, invalid[i].x, invalid[i].y, invalid[i].w, invalid[i].h,
            invalid[i].flags, &pitch, &token) && errno == EINVAL);
        CHECK(pitch == 101 && token == (void *)(uintptr_t)102);
    }
    gbm_bo_unmap(bo, whole_token);
    void *fresh_token = NULL;
    whole = gbm_bo_map(bo, 0, 0, 4, 3, 0, &stride, &fresh_token);
    CHECK(whole && fresh_token && fresh_token != whole_token && fresh_token != region_token);
    gbm_bo_unmap(bo, whole_token);
    CHECK(!memcmp(whole + stride + 4, &color, 4));
    uint32_t replacement = 0xffabcdef;
    CHECK(gbm_bo_write(bo, &replacement, 4) == 0 && !memcmp(whole, &replacement, 4));
    gbm_bo_unmap(bo, fresh_token);
    CHECK(gbm_bo_write(bo, &color, 4) == 0);
    whole = gbm_bo_map(bo, 0, 0, 4, 3, GBM_BO_TRANSFER_READ, &stride, &fresh_token);
    CHECK(whole && !memcmp(whole, &color, 4));
    gbm_bo_unmap(bo, fresh_token);
    gbm_bo_destroy(bo); gbm_bo_destroy(other); gbm_device_destroy(device);
    CHECK(close(fd) == 0);
    puts("OK GBM CPU regions and retained mapping leases");
    return 0;
}
