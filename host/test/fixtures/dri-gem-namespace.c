#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <unistd.h>

struct dumb { uint32_t height, width, bpp, flags, handle, pitch; uint64_t size; };
struct mapping { uint32_t handle, pad; uint64_t offset; };
struct prime { uint32_t handle, flags; int32_t fd; };
struct gem_close { uint32_t handle, pad; };
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "line %d: %s (errno %d)\n", __LINE__, #x, errno); exit(1); } } while (0)
#define CREATE 0xc02064b2
#define MAP 0xc01064b3
#define CLOSE 0x40086409
#define EXPORT 0xc00c642d
#define IMPORT 0xc00c642e

static uint32_t create(int fd) {
    struct dumb bo = {.height = 4, .width = 4, .bpp = 32};
    CHECK(ioctl(fd, CREATE, &bo) == 0);
    return bo.handle;
}

int main(int argc, char **argv) {
    CHECK(argc == 2);
    int fd = open("/dev/dri/renderD128", O_RDWR);
    CHECK(fd >= 0);
    uint32_t initial = create(fd);
    if (strcmp(argv[1], "prime") == 0) {
        struct prime shared = {.handle = initial, .flags = 2};
        CHECK(ioctl(fd, EXPORT, &shared) == 0);
        struct prime reimport = {.fd = shared.fd};
        CHECK(ioctl(fd, IMPORT, &reimport) == 0);
        CHECK(reimport.handle == initial);
        int other = open("/dev/dri/renderD128", O_RDWR);
        CHECK(other >= 0);
        struct prime first = {.fd = shared.fd}, second = {.fd = shared.fd};
        CHECK(ioctl(other, IMPORT, &first) == 0);
        CHECK(ioctl(other, IMPORT, &second) == 0);
        CHECK(first.handle == second.handle);
        struct gem_close close_handle = {.handle = first.handle};
        CHECK(ioctl(other, CLOSE, &close_handle) == 0);
        errno = 0;
        CHECK(ioctl(other, CLOSE, &close_handle) == -1 && errno == EINVAL);
        CHECK(close(other) == 0 && close(shared.fd) == 0 && close(fd) == 0);
        puts("prime namespace: ok");
        return 0;
    }
    CHECK(strcmp(argv[1], "namespace") == 0);
    int alias = dup(fd), changed[2], retire[2];
    CHECK(alias >= 0 && pipe(changed) == 0 && pipe(retire) == 0);
    pid_t child = fork();
    CHECK(child >= 0);
    if (child == 0) {
        struct gem_close remove = {.handle = initial};
        CHECK(ioctl(alias, CLOSE, &remove) == 0);
        uint32_t next = create(alias);
        CHECK(write(changed[1], &next, sizeof(next)) == sizeof(next));
        char acknowledgement;
        CHECK(read(retire[0], &acknowledgement, 1) == 1);
        CHECK(close(fd) == 0 && close(alias) == 0);
        return 0;
    }
    uint32_t next;
    CHECK(read(changed[0], &next, sizeof(next)) == sizeof(next));
    struct mapping absent = {.handle = initial, .offset = 0xa5a5a5a5a5a5a5a5ULL};
    struct mapping original = absent;
    errno = 0;
    CHECK(ioctl(fd, MAP, &absent) == -1 && errno == ENOENT);
    CHECK(memcmp(&absent, &original, sizeof(absent)) == 0);
    struct mapping inherited = {.handle = next};
    CHECK(ioctl(fd, MAP, &inherited) == 0);
    CHECK(create(fd) != next);
    CHECK(write(retire[1], "r", 1) == 1);
    int status;
    CHECK(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    CHECK(ioctl(alias, MAP, &inherited) == 0);
    CHECK(close(fd) == 0 && close(alias) == 0);
    puts("inherited namespace: ok");
    return 0;
}
