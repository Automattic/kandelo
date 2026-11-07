#define _GNU_SOURCE
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>

#define MIB ((size_t)1024 * 1024)
#define CHECK(condition) do { \
    if (!(condition)) { \
        fprintf(stderr, "guest address space: line %d: %s (errno %d)\n", \
                __LINE__, #condition, errno); \
        return 1; \
    } \
} while (0)

/* Host samples both address spaces before acknowledging each completed step. */
static int phase(const char *name) {
    printf("MEMORY PHASE %s\n", name);
    return getchar() == 'x';
}

int main(void) {
    setbuf(stdout, NULL);
    setbuf(stdin, NULL);
    size_t page = (size_t)sysconf(_SC_PAGESIZE);
    CHECK(page == 65536);
    CHECK(phase("ready"));

    int anonymous = MAP_PRIVATE | MAP_ANONYMOUS;
    int writable = PROT_READ | PROT_WRITE;
    unsigned char *reservation = mmap(NULL, 256 * MIB, PROT_NONE, anonymous, -1, 0);
    CHECK(reservation != MAP_FAILED);
    CHECK(phase("reserved"));

    unsigned char *plain = mmap(NULL, 2 * page, writable, anonymous, -1, 0);
    CHECK(plain != MAP_FAILED);
    memset(plain, 0x5a, 2 * page);
    CHECK(phase("anonymous"));

    unsigned char *fixed = reservation + 128 * MIB;
    CHECK(mmap(fixed, page, writable, anonymous | MAP_FIXED, -1, 0) == fixed);
    CHECK(fixed[0] == 0 && fixed[page - 1] == 0);
    fixed[0] = 0x39;
    CHECK(fixed[0] == 0x39);
    CHECK(phase("fixed"));

    unsigned char *blocker = plain + 2 * page;
    CHECK(mmap(blocker, page, writable, anonymous | MAP_FIXED, -1, 0) == blocker);
    unsigned char *moved = mremap(plain, 2 * page, 4 * page, MREMAP_MAYMOVE);
    CHECK(moved != MAP_FAILED && moved != plain);
    CHECK(moved[0] == 0x5a && moved[2 * page - 1] == 0x5a);
    CHECK(moved[2 * page] == 0 && moved[4 * page - 1] == 0);
    CHECK(phase("remapped"));

    int fd = open("/tmp/address-space-probe", O_CREAT | O_TRUNC | O_RDWR, 0600);
    CHECK(fd >= 0 && write(fd, "abc", 3) == 3);
    unsigned char *file = mmap(NULL, page, writable, MAP_PRIVATE, fd, 0);
    CHECK(file != MAP_FAILED);
    CHECK(memcmp(file, "abc", 3) == 0 && file[page - 1] == 0);
    file[0] = 'z';
    CHECK(phase("file"));

    void *old_break = sbrk(0);
    errno = 0;
    CHECK((uintptr_t)syscall(SYS_brk, 1024 * MIB + page) == (uintptr_t)old_break);
    CHECK(sbrk(0) == old_break);
    errno = 0;
    CHECK(mmap(NULL, 1024 * MIB, writable, anonymous, -1, 0) == MAP_FAILED);
    CHECK(errno == ENOMEM);
    errno = 0;
    CHECK(mremap(moved, 4 * page, 1024 * MIB, MREMAP_MAYMOVE) == MAP_FAILED);
    CHECK(errno == ENOMEM && moved[0] == 0x5a && fixed[0] == 0x39);
    CHECK(phase("rejected"));

    CHECK(munmap(file, page) == 0 && close(fd) == 0);
    CHECK(unlink("/tmp/address-space-probe") == 0);
    CHECK(munmap(reservation, 256 * MIB) == 0);
    CHECK(munmap(moved, 4 * page) == 0 && munmap(blocker, page) == 0);
    puts("GUEST ADDRESS SPACE PASS");
    return 0;
}
