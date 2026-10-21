/* Exercise Linux's KMS cursor ABI through the real guest syscall channel. */
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include <spawn.h>
#include <sys/wait.h>
extern char **environ;

struct cap { uint64_t capability, value; };
struct dumb { uint32_t height, width, bpp, flags, handle, pitch; uint64_t size; };
struct cursor { uint32_t flags, crtc; int32_t x, y; uint32_t width, height, handle; int32_t hot_x, hot_y; };
#define CHECK(condition) do { if (!(condition)) { perror(#condition); return 1; } } while (0)
struct map_dumb { uint32_t handle, pad; uint64_t offset; };

static uint32_t *map_cursor(int fd, uint32_t handle) {
    struct map_dumb map = {.handle = handle};
    if (ioctl(fd, 0xc01064b3, &map) != 0) return MAP_FAILED;
    return mmap(NULL, 64 * 64 * 4, PROT_READ | PROT_WRITE, MAP_SHARED, fd, map.offset);
}

int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "spawn-child") == 0) return 0;
    if (argc == 4 && strcmp(argv[1], "after-exec") == 0) {
        int fd = atoi(argv[2]);
        uint32_t handle = strtoul(argv[3], NULL, 10);
        uint32_t *pixels = map_cursor(fd, handle);
        CHECK(pixels != MAP_FAILED);
        CHECK(pixels[0] == 0xff223344 && pixels[4095] == 0xff556677);
        struct cursor move = {.flags = 2, .crtc = 1, .x = 70, .y = 80};
        CHECK(ioctl(fd, 0xc01c64a3, &move) == 0);
        CHECK(munmap(pixels, 64 * 64 * 4) == 0);
        struct cursor hide = {.flags = 1, .crtc = 1};
        CHECK(ioctl(fd, 0xc02464bb, &hide) == 0);
        CHECK(ioctl(fd, 0xc00464b4, &handle) == 0);
        CHECK(ioctl(fd, 0x641f, 0) == 0);
        CHECK(close(fd) == 0);
        puts("kms-cursor-exec: ok");
        return 0;
    }
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
    if (argc == 2 && strcmp(argv[1], "exec") == 0) {
        uint32_t *pixels = map_cursor(fd, bo.handle);
        CHECK(pixels != MAP_FAILED);
        pixels[0] = 0xff223344;
        pixels[4095] = 0xff556677;
        char fd_arg[16], handle_arg[16];
        snprintf(fd_arg, sizeof(fd_arg), "%d", fd);
        snprintf(handle_arg, sizeof(handle_arg), "%u", bo.handle);
        execl("/bin/kms-cursor", "kms-cursor", "after-exec", fd_arg, handle_arg, (char *)NULL);
        CHECK(0 && "exec failed");
    }
    if (argc == 2 && strcmp(argv[1], "spawn") == 0) {
        uint32_t *pixels = map_cursor(fd, bo.handle);
        CHECK(pixels != MAP_FAILED);
        pixels[0] = 0xff223344;
        pixels[4095] = 0xff556677;
        CHECK(fcntl(fd, F_SETFD, FD_CLOEXEC) == 0);
        char *child_argv[] = {"kms-cursor", "spawn-child", NULL};
        pid_t child;
        for (int attempt = 0; attempt < 3; attempt++) {
            if (attempt < 2) {
                CHECK(posix_spawn(&child, "/bin/kms-cursor", NULL, NULL, child_argv, environ) == 0);
                int status;
                CHECK(waitpid(child, &status, 0) == child);
                CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 0);
            } else {
                CHECK(posix_spawn(&child, "/bin/no-such-cursor-probe", NULL, NULL, child_argv, environ) == ENOENT);
            }
            CHECK(munmap(pixels, 64 * 64 * 4) == 0);
            pixels = map_cursor(fd, bo.handle);
            CHECK(pixels != MAP_FAILED);
            CHECK(pixels[0] == 0xff223344 && pixels[4095] == 0xff556677);
        }
        CHECK(munmap(pixels, 64 * 64 * 4) == 0);
        puts("kms-cursor-spawn: ok");
    }
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
