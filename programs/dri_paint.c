/*
 * dri_paint — visible browser demo for milestone (A).
 *
 * Same flow as dumb_roundtrip (programs/dumb_roundtrip.c), but the
 * child writes the verified buffer bytes to /tmp/dri-paint.raw before
 * exiting. Pages can read that file via kernel.fs and paint the bytes
 * onto a canvas, proving visually that the parent's gradient survived
 * PRIME export → fork → PRIME import → mmap on the imported handle.
 *
 *   parent
 *     1. open /dev/dri/renderD128
 *     2. gbm_create_device(fd)
 *     3. gbm_bo_create(W×H, ARGB8888, LINEAR)
 *     4. gbm_bo_map → write a deterministic gradient
 *     5. gbm_bo_get_fd → PRIME export the bo
 *     6. fork(); prime fd inherited by the child via fd table
 *   child
 *     7. gbm_create_device(fd) on the inherited fd
 *     8. gbm_bo_import(GBM_BO_IMPORT_FD, prime_fd)
 *     9. gbm_bo_map → MAP_DUMB + mmap on the imported handle
 *    10. verify every pixel matches the parent's gradient
 *    11. write the verified buffer to /tmp/dri-paint.raw
 *    12. _exit(0) on full success
 *   parent
 *    13. waitpid the child; print sentinel; exit 0
 *
 * Defense in depth: Playwright asserts both the exit-0 + sentinel
 * (program completed) AND samples canvas pixels (the bytes on disk
 * really are the gradient — catches a future SAB-sync regression
 * that produces zeros without crashing).
 *
 * Stride is queried via the &stride out-param of gbm_bo_map. Buffer
 * length on disk is `stride * H` so the page knows what to read
 * even if stride > W*4 (libgbm shim returns W*4 today, but the
 * convention survives a future driver that pads rows).
 */
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#include <errno.h>

#include <gbm.h>
#include <drm/drm_fourcc.h>

#define W 256
#define H 256

#define DUMP_PATH "/tmp/dri-paint.raw"

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

        /* /tmp is created by both host memfs init paths (browser-kernel-host.ts
         * and the Node rootfs.vfs default mounts), but mkdir-with-EEXIST keeps
         * the demo robust against a future VFS shape that ships without it. */
        if (mkdir("/tmp", 0755) != 0 && errno != EEXIST) {
            perror("FAIL: mkdir /tmp"); _exit(5);
        }
        int of = open(DUMP_PATH, O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (of < 0) { perror("FAIL: open " DUMP_PATH); _exit(5); }
        size_t total = (size_t)cstride * H;
        const uint8_t *bytes = (const uint8_t *)cpx;
        size_t written = 0;
        while (written < total) {
            ssize_t n = write(of, bytes + written, total - written);
            if (n < 0) {
                if (errno == EINTR) continue;
                perror("FAIL: write " DUMP_PATH); _exit(6);
            }
            written += (size_t)n;
        }
        if (close(of) != 0) { perror("FAIL: close " DUMP_PATH); _exit(7); }

        _exit(0);
    }

    int status = 0;
    if (waitpid(pid, &status, 0) < 0) { perror("waitpid"); return 1; }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "FAIL: child exited abnormally (status=0x%x)\n", status);
        return 1;
    }

    static const char ok[] = "milestone (A) PAINT\n";
    write(1, ok, sizeof ok - 1);
    return 0;
}
