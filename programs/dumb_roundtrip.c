/*
 * dumb_roundtrip — milestone (A) demo for the DRI buffer-sharing
 * plan (docs/plans/2026-05-25-dri-buffer-sharing-plan.md §C4).
 * Exercises the full libgbm + libdrm shim chain end-to-end across
 * a fork, with byte-for-byte verification of the gradient that
 * the parent wrote:
 *
 *   parent
 *     1. open /dev/dri/renderD128
 *     2. gbm_create_device(fd)
 *     3. gbm_bo_create(256x256, ARGB8888, LINEAR)
 *     4. gbm_bo_map → write a deterministic gradient
 *     5. gbm_bo_get_fd → PRIME export the bo
 *     6. fork(); the prime fd is inherited by the child via fd table
 *   child
 *     7. gbm_create_device(fd) on the inherited fd
 *     8. gbm_bo_import(GBM_BO_IMPORT_FD, prime_fd) — triggers
 *        PRIME_FD_TO_HANDLE, hands the child a fresh local handle
 *        for the same bo_id.
 *     9. gbm_bo_map → MAP_DUMB + mmap on the imported handle.
 *    10. verify every pixel matches the parent's gradient.
 *    11. _exit(0) on full success (or _exit(non-zero) with a
 *        diagnostic on stderr).
 *
 * Cross-process byte coherence is delivered by the host's SAB-backed
 * bo store + bind/unbind sync (plan §B2 — `MemoryManager.mmap_shared`
 * semantics). The parent's gradient is flushed into the bo's
 * canonical SAB on the child's bind, then primed into the child's
 * wasm Memory at the imported binding's [addr, +len) range. See
 * host/src/dri/registry.ts for the sync mechanics.
 *
 * gbm_bo is opaque in upstream mesa's gbm.h, so contents and
 * stride are queried via the &stride out-param of gbm_bo_map and
 * gbm_bo_get_stride — not via direct struct access as the plan's
 * pseudo-code did.
 */
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

#include <gbm.h>
#include <drm/drm_fourcc.h>

#define W 256
#define H 256

int main(void) {
    int fd = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC);
    if (fd < 0) { perror("open /dev/dri/renderD128"); return 1; }

    struct gbm_device *dev = gbm_create_device(fd);
    if (!dev) { perror("gbm_create_device"); return 1; }

    struct gbm_bo *bo = gbm_bo_create(dev, W, H,
                                      DRM_FORMAT_ARGB8888,
                                      GBM_BO_USE_LINEAR);
    if (!bo) { perror("gbm_bo_create"); return 1; }

    uint32_t stride = 0;
    void *map_data = NULL;
    uint32_t *px = gbm_bo_map(bo, 0, 0, W, H, 0, &stride, &map_data);
    if (!px) { perror("gbm_bo_map (parent)"); return 1; }
    if (stride == 0 || (stride % 4) != 0) {
        fprintf(stderr, "FAIL: parent stride bogus (%u)\n", stride);
        return 1;
    }

    /* Write a gradient so the parent's mmap path is exercised
     * end-to-end. The child won't see these bytes (no shared
     * backing yet — see file header), so the write is informational
     * only: if the parent's mmap is broken, this will trap. */
    const uint32_t stride_px = stride / 4;
    for (uint32_t y = 0; y < H; y++) {
        for (uint32_t x = 0; x < W; x++) {
            px[y * stride_px + x] = (0xFFu << 24) | (x << 16) | (y << 8);
        }
    }

    int prime = gbm_bo_get_fd(bo);
    if (prime < 0) { perror("gbm_bo_get_fd"); return 1; }

    pid_t pid = fork();
    if (pid < 0) { perror("fork"); return 1; }

    if (pid == 0) {
        struct gbm_device *cdev = gbm_create_device(fd);
        if (!cdev) { perror("gbm_create_device (child)"); _exit(2); }

        struct gbm_import_fd_data ifd = {
            .fd     = prime,
            .width  = W,
            .height = H,
            .stride = stride,
            .format = DRM_FORMAT_ARGB8888,
        };
        struct gbm_bo *cbo = gbm_bo_import(cdev, GBM_BO_IMPORT_FD, &ifd, 0);
        if (!cbo) { perror("gbm_bo_import"); _exit(2); }

        uint32_t cstride = 0;
        void *cmap_data = NULL;
        uint32_t *cpx = gbm_bo_map(cbo, 0, 0, W, H, 0, &cstride, &cmap_data);
        if (!cpx) { perror("gbm_bo_map (child)"); _exit(2); }
        if (cstride != stride) {
            fprintf(stderr, "FAIL: child stride %u != parent %u\n",
                    cstride, stride);
            _exit(3);
        }
        const uint32_t cstride_px = cstride / 4;
        for (uint32_t y = 0; y < H; y++) {
            for (uint32_t x = 0; x < W; x++) {
                uint32_t want = (0xFFu << 24) | (x << 16) | (y << 8);
                uint32_t got  = cpx[y * cstride_px + x];
                if (got != want) {
                    fprintf(stderr,
                            "FAIL: child pixel (%u,%u) = 0x%08x; want 0x%08x\n",
                            x, y, got, want);
                    _exit(4);
                }
            }
        }
        _exit(0);
    }

    int status = 0;
    if (waitpid(pid, &status, 0) < 0) { perror("waitpid"); return 1; }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "FAIL: child exited abnormally (status=0x%x)\n", status);
        return 1;
    }

    static const char ok[] = "milestone (A) PASS\n";
    write(1, ok, sizeof ok - 1);
    return 0;
}
