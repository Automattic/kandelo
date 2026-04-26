/*
 * fbtest — open /dev/fb0, query geometry, mmap the pixel buffer, write a
 * known pattern, and pause.
 *
 * Used by host/test/framebuffer-integration.test.ts to verify the kernel
 * binds the framebuffer correctly and the host can read pixel bytes back
 * out of the bound region of the process Memory SAB.
 *
 * Pattern: pixel at (col=c, row=r) is 0xFF000000 | (r << 16) | c
 *          (alpha 0xFF, red = row, blue = col, green = 0)
 */
#include <fcntl.h>
#include <linux/fb.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

int main(void) {
    int fd = open("/dev/fb0", O_RDWR);
    if (fd < 0) { perror("open /dev/fb0"); return 1; }

    struct fb_var_screeninfo v;
    if (ioctl(fd, FBIOGET_VSCREENINFO, &v) < 0) {
        perror("FBIOGET_VSCREENINFO"); return 1;
    }
    struct fb_fix_screeninfo f;
    if (ioctl(fd, FBIOGET_FSCREENINFO, &f) < 0) {
        perror("FBIOGET_FSCREENINFO"); return 1;
    }

    uint32_t* px = mmap(NULL, f.smem_len, PROT_READ | PROT_WRITE,
                        MAP_SHARED, fd, 0);
    if (px == MAP_FAILED) { perror("mmap /dev/fb0"); return 1; }

    for (uint32_t r = 0; r < v.yres; r++) {
        for (uint32_t c = 0; c < v.xres; c++) {
            px[r * v.xres + c] =
                0xFF000000u | ((uint32_t)r << 16) | (uint32_t)c;
        }
    }

    /* Signal "done writing" to the test harness. */
    write(1, "ok\n", 3);

    /* Wait for the test harness to inspect the framebuffer and signal
     * shutdown. The harness sends SIGTERM after it's done. */
    pause();
    return 0;
}
