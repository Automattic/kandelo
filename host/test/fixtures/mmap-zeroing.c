#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#define CHECK(condition) do { \
    if (!(condition)) { \
        fprintf(stderr, "mmap zeroing: line %d: %s (errno %d)\n", \
                __LINE__, #condition, errno); \
        return 1; \
    } \
} while (0)

static int filled(const unsigned char *bytes, size_t length, unsigned char value) {
    for (size_t i = 0; i < length; ++i)
        if (bytes[i] != value) return 0;
    return 1;
}

int main(void) {
    long page_size = sysconf(_SC_PAGESIZE);
    CHECK(page_size > 0);
    size_t page = (size_t)page_size;
    int protection = PROT_READ | PROT_WRITE;
    int anonymous = MAP_PRIVATE | MAP_ANONYMOUS;

    unsigned char *reserved = mmap(NULL, 9 * page, PROT_NONE, anonymous, -1, 0);
    CHECK(reserved != MAP_FAILED);
    CHECK(mprotect(reserved, 9 * page, protection) == 0);
    CHECK(filled(reserved, 9 * page, 0));
    memset(reserved, 0xa5, 9 * page);
    CHECK(mmap(reserved, 3 * page, protection, anonymous | MAP_FIXED, -1, 0) == reserved);
    CHECK(filled(reserved, 3 * page, 0));
    CHECK(filled(reserved + 3 * page, 6 * page, 0xa5));
    CHECK(munmap(reserved, 9 * page) == 0);

    int fd = open("/tmp/mmap-zero-tail", O_CREAT | O_TRUNC | O_RDWR, 0600);
    CHECK(fd >= 0);
    unsigned char data[127];
    memset(data, 0x6a, sizeof(data));
    CHECK(write(fd, data, sizeof(data)) == sizeof(data));
    unsigned char *file = mmap(NULL, page, protection, MAP_PRIVATE, fd, 0);
    CHECK(file != MAP_FAILED);
    CHECK(filled(file, sizeof(data), 0x6a));
    CHECK(filled(file + sizeof(data), page - sizeof(data), 0));
    CHECK(munmap(file, page) == 0);
    CHECK(close(fd) == 0);
    CHECK(unlink("/tmp/mmap-zero-tail") == 0);

    unsigned char *in_place = mmap(NULL, 2 * page, protection, anonymous, -1, 0);
    CHECK(in_place != MAP_FAILED);
    memset(in_place, 0x3c, 2 * page);
    CHECK(mremap(in_place, 2 * page, 3 * page, 0) == in_place);
    CHECK(filled(in_place, 2 * page, 0x3c));
    CHECK(filled(in_place + 2 * page, page, 0));
    CHECK(munmap(in_place, 3 * page) == 0);

    unsigned char *source = mmap(NULL, 2 * page, protection, anonymous, -1, 0);
    CHECK(source != MAP_FAILED);
    unsigned char *blocker = mmap(source + 2 * page, page, protection,
                                 anonymous | MAP_FIXED, -1, 0);
    CHECK(blocker == source + 2 * page);
    memset(source, 0x3c, 2 * page);
    unsigned char *moved = mremap(source, 2 * page, 4 * page, MREMAP_MAYMOVE);
    CHECK(moved != MAP_FAILED && moved != source);
    CHECK(filled(moved, 2 * page, 0x3c));
    CHECK(filled(moved + 2 * page, 2 * page, 0));
    CHECK(munmap(moved, 4 * page) == 0);
    CHECK(munmap(blocker, page) == 0);
    puts("MMAP ZEROING PASS");
    return 0;
}
