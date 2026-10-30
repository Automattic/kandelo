#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

struct dumb { uint32_t height, width, bpp, flags, handle, pitch; uint64_t size; };
struct prime { uint32_t handle, flags; int32_t fd; };
struct mapping { uint32_t handle, pad; uint64_t offset; };
struct cursor { uint32_t flags, crtc; int32_t x, y; uint32_t width, height, handle; int32_t hot_x, hot_y; };
#define CHECK(x) do { if (!(x)) { perror(#x); exit(1); } } while (0)

static uint32_t *map_bo(int fd, uint32_t handle) {
    struct mapping map = {.handle = handle};
    if (ioctl(fd, 0xc01064b3, &map) != 0) return MAP_FAILED;
    return mmap(NULL, 16384, PROT_READ | PROT_WRITE, MAP_SHARED, fd, map.offset);
}

int main(int argc, char **argv) {
    int map_early = argc > 1 && strcmp(argv[1], "mapped-owner") == 0;
    int gate[2], result[2];
    CHECK(pipe(gate) == 0 && pipe(result) == 0);
    pid_t allocator = fork();
    CHECK(allocator >= 0);
    if (allocator == 0) {
        int fd = open("/dev/dri/card0", O_RDWR);
        CHECK(fd >= 0);
        struct dumb bo = {.width = 64, .height = 64, .bpp = 32};
        CHECK(ioctl(fd, 0xc02064b2, &bo) == 0);
        uint32_t *pixels = map_bo(fd, bo.handle);
        CHECK(pixels != MAP_FAILED);
        pixels[0] = 0xff112233;
        pixels[4095] = 0xff445566;
        struct prime shared = {.handle = bo.handle, .flags = 2 /* DRM_RDWR */};
        CHECK(ioctl(fd, 0xc00c642d, &shared) == 0);
        /* The allocator's primary-card open acquired master. A consumer
         * opening a different description cannot steal that authority. */
        CHECK(ioctl(fd, 0x641f, 0) == 0);
        int ready[2];
        CHECK(pipe(ready) == 0);
        pid_t consumer = fork();
        CHECK(consumer >= 0);
        if (consumer == 0) {
            CHECK(close(fd) == 0);
            int card = open("/dev/dri/card0", O_RDWR);
            CHECK(card >= 0);
            struct prime imported = {.fd = shared.fd};
            CHECK(ioctl(card, 0xc00c642e, &imported) == 0);
            CHECK(close(shared.fd) == 0);
            CHECK(ioctl(card, 0x641e, 0) == 0);
            struct cursor image = {.flags = 3, .crtc = 1, .width = 64, .height = 64,
                                   .handle = imported.handle, .x = 30, .y = 40};
            CHECK(ioctl(card, 0xc02464bb, &image) == 0);
            if (map_early) {
                uint32_t *early = map_bo(card, imported.handle);
                CHECK(early != MAP_FAILED && early[0] == 0xff112233);
                CHECK(munmap(early, 16384) == 0);
            }
            CHECK(write(ready[1], "r", 1) == 1);
            char byte;
            CHECK(read(gate[0], &byte, 1) == 1);
            uint32_t *retained = map_bo(card, imported.handle);
            int ok = retained != MAP_FAILED && retained[0] == 0xff112233
                && retained[4095] == 0xff445566;
            if (retained == MAP_FAILED) perror("map imported cursor after allocator exit");
            CHECK(write(result[1], &ok, sizeof(ok)) == sizeof(ok));
            exit(ok ? 0 : 1);
        }
        char byte;
        CHECK(read(ready[0], &byte, 1) == 1);
        if (argc > 1 && strcmp(argv[1], "terminate-owner") == 0) {
            printf("allocator-ready=%d\n", getpid());
            fflush(stdout);
            CHECK(read(gate[0], &byte, 1) == 1);
        }
        if (argc > 1 && strcmp(argv[1], "trap-owner") == 0) __builtin_trap();
        exit(0);
    }
    char permission;
    if (argc > 1 && strcmp(argv[1], "terminate-owner") == 0) {
        // Hard host removal is not a POSIX signal exit. The test driver
        // acknowledges exact worker retirement before releasing this barrier.
        CHECK(read(STDIN_FILENO, &permission, 1) == 1);
        puts("allocator removed by host");
    } else {
        int status;
        CHECK(waitpid(allocator, &status, 0) == allocator);
        CHECK((WIFEXITED(status) && WEXITSTATUS(status) == 0)
              || (argc > 1 && strcmp(argv[1], "trap-owner") == 0 && WIFSIGNALED(status)));
        printf("allocator-reaped=%d\n", allocator);
        fflush(stdout);
        CHECK(read(STDIN_FILENO, &permission, 1) == 1);
    }
    CHECK(write(gate[1], "g", 1) == 1);
    int ok = 0;
    CHECK(read(result[0], &ok, sizeof(ok)) == sizeof(ok));
    printf("imported cursor after allocator exit: %s\n", ok ? "ok" : "FAILED");
    return ok ? 0 : 1;
}
