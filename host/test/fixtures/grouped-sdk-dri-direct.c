#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>
struct dumb { uint32_t height, width, bpp, flags, handle, pitch; uint64_t size; };
struct mapping { uint32_t handle, pad; uint64_t offset; };
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "line %d: %s errno=%d\n", __LINE__, #x, errno); exit(1); } } while (0)
int main(void) {
    const size_t page = 65536;
    int fd = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC); CHECK(fd >= 0);
    struct dumb bo = { .width = 256, .height = 192, .bpp = 32 };
    CHECK(ioctl(fd, 0xc02064b2u, &bo) == 0 && bo.size == 3 * page);
    struct mapping map = { .handle = bo.handle };
    CHECK(ioctl(fd, 0xc01064b3u, &map) == 0);
    /* The object must admit its whole storage even when its first VMA is a
       bounded prefix. The later full alias must not zero or replace it. */
    volatile unsigned char *a = mmap(NULL, page, PROT_READ | PROT_WRITE, MAP_SHARED, fd, map.offset);
    CHECK(a != MAP_FAILED);
    a[7] = 17;
    volatile unsigned char *b = mmap(NULL, 3 * page, PROT_READ | PROT_WRITE, MAP_SHARED, fd, map.offset);
    CHECK(b != MAP_FAILED && b[7] == 17);
    /* No syscall, readiness poll or presentation between these stores and
       loads: periodic private-memory reconciliation cannot satisfy this. */
    a[0] = 41;
    b[1] = 59;
    const int direct = b[0] == 41 && a[1] == 59;
    if (!direct) {
        CHECK(munmap((void *)a, page) == 0 && munmap((void *)b, 3 * page) == 0 && close(fd) == 0);
        fputs("DIRECT-ALIAS-UNAVAILABLE\n", stderr);
        return 23;
    }
    b[2 * page + 9] = 79;
    CHECK(close(fd) == 0 && munmap((void *)a, page) == 0);
    CHECK(b[0] == 41 && b[1] == 59 && b[2 * page + 9] == 79);
    CHECK(munmap((void *)b, 3 * page) == 0);
    puts("grouped-sdk-dri-direct PASS");
    return 0;
}
