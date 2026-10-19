/* Exercise Linux's KMS cursor ABI through the real guest syscall channel. */
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <unistd.h>

struct cap { uint64_t capability, value; };
struct dumb { uint32_t height, width, bpp, flags, handle, pitch; uint64_t size; };
struct cursor { uint32_t flags, crtc; int32_t x, y; uint32_t width, height, handle; int32_t hot_x, hot_y; };
#define CHECK(condition) do { if (!(condition)) { perror(#condition); return 1; } } while (0)
int main(void) {
    int fd = open("/dev/dri/card0", O_RDWR);
    CHECK(fd >= 0);
    struct cap width = {8, 0}, height = {9, 0};
    CHECK(ioctl(fd, 0xc010640c, &width) == 0 && width.value == 64);
    CHECK(ioctl(fd, 0xc010640c, &height) == 0 && height.value == 64);
    CHECK(ioctl(fd, 0x641e, 0) == 0);
    struct dumb bo = {.height = 64, .width = 64, .bpp = 32};
    CHECK(ioctl(fd, 0xc02064b2, &bo) == 0);
    struct cursor cursor = {.flags = 3, .crtc = 1, .x = 30, .y = 40,
                            .width = 64, .height = 64, .handle = bo.handle,
                            .hot_x = -3, .hot_y = 4};
    CHECK(ioctl(fd, 0xc02464bb, &cursor) == 0);
    cursor.flags = 2;
    cursor.x = -5;
    CHECK(ioctl(fd, 0xc01c64a3, &cursor) == 0);
    cursor.flags = 4;
    errno = 0;
    CHECK(ioctl(fd, 0xc02464bb, &cursor) == -1 && errno == EINVAL);
    cursor.flags = 1;
    cursor.handle = 0;
    CHECK(ioctl(fd, 0xc02464bb, &cursor) == 0);
    CHECK(ioctl(fd, 0xc00464b4, &bo.handle) == 0);
    CHECK(ioctl(fd, 0x641f, 0) == 0);
    CHECK(close(fd) == 0);
    puts("kms-cursor: ok");
    return 0;
}
