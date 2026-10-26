#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

/* Linux UAPI layouts, also checked by shared::dri's layout tests. */
struct dumb { uint32_t height, width, bpp, flags, handle, pitch; uint64_t size; };
struct mapping { uint32_t handle, pad; uint64_t offset; };
struct cursor { uint32_t flags, crtc; int32_t x, y; uint32_t width, height, handle; int32_t hot_x, hot_y; };
struct client_cap { uint64_t capability, value; };
struct planes { uint64_t ids; uint32_t count, pad; };
struct gem_close { uint32_t handle, pad; };
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "line %d: %s (errno %d)\n", __LINE__, #x, errno); exit(1); } } while (0)

int main(int argc, char **argv) {
    CHECK(argc == 2 && (strcmp(argv[1], "master") == 0 || strcmp(argv[1], "cursor") == 0));
    int fd = open("/dev/dri/card0", O_RDWR), ready[2];
    CHECK(fd >= 0 && pipe(ready) == 0);
    uint32_t magic = 0;
    CHECK(ioctl(fd, 0x80046402, &magic) == 0 && magic != 0);
    struct dumb bo = {.width = 16, .height = 16, .bpp = 32};
    CHECK(ioctl(fd, 0xc02064b2, &bo) == 0);
    struct mapping map = {.handle = bo.handle};
    CHECK(ioctl(fd, 0xc01064b3, &map) == 0);
    uint32_t *pixels = mmap(NULL, bo.size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, map.offset);
    CHECK(pixels != MAP_FAILED);
    for (uint32_t y = 0; y < bo.height; ++y)
        for (uint32_t x = 0; x < bo.width; ++x)
            pixels[y * (bo.pitch / 4) + x] = 0xff00ff00;
    CHECK(munmap(pixels, bo.size) == 0);
    struct cursor cursor = {.flags = 3, .crtc = 1, .width = bo.width, .height = bo.height,
                            .handle = bo.handle, .x = 5, .y = 5};
    CHECK(ioctl(fd, 0xc02464bb, &cursor) == 0);
    pid_t child = fork();
    CHECK(child >= 0);
    if (child != 0) {
        CHECK(close(ready[1]) == 0);
        char byte;
        CHECK(read(ready[0], &byte, 1) == 1 && byte == 'r');
        struct planes planes = {0};
        CHECK(ioctl(fd, 0xc01064b5, &planes) == 0 && planes.count == 1);
        CHECK(close(ready[0]) == 0 && close(fd) == 0);
        /* The driver awaits this process's natural exit AND acknowledged
         * Worker retirement before releasing the surviving child. */
        return 0;
    }
    CHECK(close(ready[0]) == 0);
    CHECK(ioctl(fd, 0x641e, 0) == 0);
    struct client_cap cap = {.capability = 2, .value = 1};
    CHECK(ioctl(fd, 0x4010640d, &cap) == 0);
    uint32_t inherited_magic = 0;
    CHECK(ioctl(fd, 0x80046402, &inherited_magic) == 0 && inherited_magic == magic);
    printf("kms-inherited-child=%d\n", getpid());
    fflush(stdout);
    CHECK(write(ready[1], "r", 1) == 1 && close(ready[1]) == 0);
    char byte;
    CHECK(read(STDIN_FILENO, &byte, 1) == 1 && byte == 'g');
    CHECK(ioctl(fd, 0x641e, 0) == 0);
    CHECK(ioctl(fd, 0xc01064b3, &map) == 0);
    pixels = mmap(NULL, bo.size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, map.offset);
    CHECK(pixels != MAP_FAILED && pixels[0] == 0xff00ff00);
    CHECK(munmap(pixels, bo.size) == 0);
    if (strcmp(argv[1], "cursor") == 0) {
        /* MOVE alone must retain the image installed by the retired opener. */
        cursor.flags = 2;
        cursor.x = 30;
        cursor.y = 40;
        CHECK(ioctl(fd, 0xc02464bb, &cursor) == 0);
    }
    printf("inherited %s after opener retirement: ready\n", argv[1]);
    fflush(stdout);
    CHECK(read(STDIN_FILENO, &byte, 1) == 1 && byte == 'q');
    cursor.flags = 1;
    cursor.handle = 0;
    CHECK(ioctl(fd, 0xc02464bb, &cursor) == 0);
    struct gem_close remove = {.handle = bo.handle};
    CHECK(ioctl(fd, 0x40086409, &remove) == 0 && close(fd) == 0);
    puts("inherited KMS file: ok");
    return 0;
}
