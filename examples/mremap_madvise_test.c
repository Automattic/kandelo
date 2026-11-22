/*
 * mremap(), madvise() and posix_madvise() through the normal libc and
 * syscall path.
 *
 * Each check prints "FAIL <what>" and the program exits 1 at the first
 * failure; success ends with MREMAP_MADVISE_PASS.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>

static long page;

#define CHECK(cond, ...)                                                   \
    do {                                                                   \
        if (!(cond)) {                                                     \
            fprintf(stderr, "FAIL line %d: ", __LINE__);                   \
            fprintf(stderr, __VA_ARGS__);                                  \
            fprintf(stderr, " (errno=%d %s)\n", errno, strerror(errno));   \
            exit(1);                                                       \
        }                                                                  \
    } while (0)

static unsigned char pattern_byte(size_t offset, unsigned seed) {
    return (unsigned char)((offset * 131u + seed) & 0xff);
}

static void fill(unsigned char *p, size_t len, size_t base, unsigned seed) {
    for (size_t i = 0; i < len; i++) p[i] = pattern_byte(base + i, seed);
}

static int matches(const unsigned char *p, size_t len, size_t base,
                   unsigned seed) {
    for (size_t i = 0; i < len; i++)
        if (p[i] != pattern_byte(base + i, seed)) return 0;
    return 1;
}

static int all_zero(const unsigned char *p, size_t len) {
    for (size_t i = 0; i < len; i++)
        if (p[i] != 0) return 0;
    return 1;
}

/* Whether any byte of [addr, addr+len) is in a mapping, from the kernel's
 * own mapping table. */
static int range_mapped(const void *addr, size_t len) {
    uintptr_t start = (uintptr_t)addr, end = start + len;
    FILE *maps = fopen("/proc/self/maps", "r");
    CHECK(maps != NULL, "open /proc/self/maps");
    char line[512];
    int found = 0;
    while (fgets(line, sizeof line, maps)) {
        unsigned long long lo, hi;
        if (sscanf(line, "%llx-%llx", &lo, &hi) != 2) continue;
        if ((uintptr_t)lo < end && (uintptr_t)hi > start) found = 1;
    }
    fclose(maps);
    return found;
}

static void *map_anon(size_t len) {
    void *p = mmap(NULL, len, PROT_READ | PROT_WRITE,
                   MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    CHECK(p != MAP_FAILED, "mmap %zu", len);
    return p;
}

static void test_shrink(void) {
    unsigned char *p = map_anon(3 * page);
    fill(p, 3 * page, 0, 1);
    void *r = mremap(p, 3 * page, page, 0);
    CHECK(r == p, "shrink returned %p, expected %p", r, (void *)p);
    CHECK(matches(p, page, 0, 1), "shrink kept the surviving page");
    CHECK(!range_mapped(p + page, 2 * page), "shrink unmapped the tail");

    /* A shrink inside one page rounds to the same page count. */
    r = mremap(p, page, 100, 0);
    CHECK(r == p, "sub-page shrink returned %p", r);
    CHECK(range_mapped(p, page), "sub-page shrink kept the page");
    CHECK(matches(p, page, 0, 1), "sub-page shrink kept the bytes");
    CHECK(munmap(p, page) == 0, "munmap after shrink");
}

static void test_grow_in_place(void) {
    unsigned char *p = map_anon(3 * page);
    CHECK(munmap(p + page, 2 * page) == 0, "open a hole after the mapping");
    fill(p, page, 0, 2);
    void *r = mremap(p, page, 3 * page, 0);
    CHECK(r == p, "in-place grow returned %p, expected %p", r, (void *)p);
    CHECK(matches(p, page, 0, 2), "in-place grow kept the prefix");
    CHECK(all_zero(p + page, 2 * page), "in-place grow zero-filled the tail");
    CHECK(range_mapped(p + 2 * page, page), "in-place grow mapped the tail");
    CHECK(munmap(p, 3 * page) == 0, "munmap after in-place grow");
}

static void test_grow_suffix_in_place(void) {
    /* The old range is the tail of a larger mapping, not its start. */
    unsigned char *p = map_anon(4 * page);
    CHECK(munmap(p + 2 * page, 2 * page) == 0, "open a hole");
    fill(p, 2 * page, 0, 3);
    void *r = mremap(p + page, page, 2 * page, 0);
    CHECK(r == p + page, "suffix grow returned %p, expected %p", r,
          (void *)(p + page));
    CHECK(matches(p, 2 * page, 0, 3), "suffix grow kept both pages");
    CHECK(all_zero(p + 2 * page, page), "suffix grow zero-filled the tail");
    CHECK(munmap(p, 3 * page) == 0, "munmap after suffix grow");
}

static void test_grow_blocked(void) {
    unsigned char *p = map_anon(2 * page);
    errno = 0;
    void *r = mremap(p, page, 2 * page, 0);
    CHECK(r == MAP_FAILED && errno == ENOMEM,
          "blocked grow without MREMAP_MAYMOVE gave %p", r);
    CHECK(munmap(p, 2 * page) == 0, "munmap after blocked grow");
}

static void test_grow_move(void) {
    unsigned char *p = map_anon(2 * page);
    /* Fill the whole first page, including bytes past old_len: they are
     * part of the mapped page and move with it. */
    fill(p, 2 * page, 0, 4);
    size_t old_len = page - 100;
    unsigned char *r = mremap(p, old_len, 3 * page, MREMAP_MAYMOVE);
    CHECK(r != MAP_FAILED, "MREMAP_MAYMOVE grow");
    CHECK(r != p, "MREMAP_MAYMOVE grow moved the mapping");
    CHECK(matches(r, page, 0, 4), "moved mapping kept the whole first page");
    CHECK(all_zero(r + page, 2 * page), "moved mapping zero-filled the tail");
    CHECK(!range_mapped(p, page), "the old range is unmapped");
    CHECK(range_mapped(p + page, page), "the rest of the old mapping remains");
    CHECK(matches(p + page, page, page, 4), "the rest kept its bytes");
    fill(r, 3 * page, 0, 5);
    CHECK(matches(r, 3 * page, 0, 5), "moved mapping is writable");
    CHECK(munmap(r, 3 * page) == 0, "munmap moved mapping");
    CHECK(munmap(p + page, page) == 0, "munmap old remainder");
}

static void test_fixed(void) {
    unsigned char *p = map_anon(page);
    unsigned char *target = map_anon(4 * page);
    fill(p, page, 0, 6);
    fill(target, 4 * page, 0, 7);

    errno = 0;
    CHECK(mremap(p, page, 2 * page, MREMAP_FIXED, target) == MAP_FAILED &&
              errno == EINVAL,
          "MREMAP_FIXED without MREMAP_MAYMOVE");
    errno = 0;
    CHECK(mremap(p, page, 2 * page, MREMAP_MAYMOVE | MREMAP_FIXED,
                 target + 1) == MAP_FAILED && errno == EINVAL,
          "MREMAP_FIXED to an unaligned address");
    errno = 0;
    CHECK(mremap(p, page, 2 * page, MREMAP_MAYMOVE | MREMAP_FIXED, p) ==
                  MAP_FAILED && errno == EINVAL,
          "MREMAP_FIXED onto the source range");

    unsigned char *r = mremap(p, page, 2 * page,
                              MREMAP_MAYMOVE | MREMAP_FIXED, target + page);
    CHECK(r == target + page, "MREMAP_FIXED returned %p, expected %p", r,
          (void *)(target + page));
    CHECK(matches(r, page, 0, 6), "MREMAP_FIXED moved the bytes");
    CHECK(all_zero(r + page, page), "MREMAP_FIXED zero-filled the tail");
    CHECK(matches(target, page, 0, 7), "MREMAP_FIXED kept the page before");
    CHECK(matches(target + 3 * page, page, 3 * page, 7),
          "MREMAP_FIXED kept the page after");
    CHECK(!range_mapped(p, page), "MREMAP_FIXED unmapped the source");
    CHECK(munmap(target, 4 * page) == 0, "munmap after MREMAP_FIXED");
}

static void test_errors(void) {
    unsigned char *p = map_anon(2 * page);
    errno = 0;
    CHECK(mremap(p + 1, page, 2 * page, MREMAP_MAYMOVE) == MAP_FAILED &&
              errno == EINVAL,
          "unaligned old address");
    errno = 0;
    CHECK(mremap(p, page, 0, MREMAP_MAYMOVE) == MAP_FAILED && errno == EINVAL,
          "zero new length");
    errno = 0;
    CHECK(mremap(p, 0, page, MREMAP_MAYMOVE) == MAP_FAILED && errno == EINVAL,
          "zero old length of a private mapping");
    errno = 0;
    CHECK(mremap(p, page, 2 * page, 0x80) == MAP_FAILED && errno == EINVAL,
          "unknown flag");
    errno = 0;
    CHECK(mremap(p, page, 2 * page, MREMAP_MAYMOVE | MREMAP_DONTUNMAP) ==
                  MAP_FAILED && errno == EINVAL,
          "MREMAP_DONTUNMAP is not implemented");
    CHECK(munmap(p, 2 * page) == 0, "munmap");
    errno = 0;
    CHECK(mremap(p, page, 2 * page, MREMAP_MAYMOVE) == MAP_FAILED &&
              errno == EFAULT,
          "unmapped old range");
}

static int make_file(const char *path, size_t len, unsigned seed) {
    int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0600);
    CHECK(fd >= 0, "create %s", path);
    unsigned char *buf = malloc(len);
    CHECK(buf != NULL, "malloc");
    fill(buf, len, 0, seed);
    CHECK(write(fd, buf, len) == (ssize_t)len, "write %s", path);
    free(buf);
    return fd;
}

/* Kandelo keeps no reference to a MAP_PRIVATE mapping's file once the
 * descriptor closes, so it cannot read pages added by growth. It refuses the
 * growth with EFAULT, Linux's answer for a non-expandable mapping, rather
 * than zero-filling file pages. Moving without growth keeps the bytes. */
static void test_private_file(void) {
    const char *path = "/tmp/mremap-private.bin";
    int fd = make_file(path, 3 * page, 8);

    unsigned char *hole = map_anon(4 * page);
    CHECK(munmap(hole, 4 * page) == 0, "free a hole");
    unsigned char *p = mmap(hole, 2 * page, PROT_READ | PROT_WRITE,
                            MAP_PRIVATE | MAP_FIXED, fd, 0);
    CHECK(p == hole, "mmap private file at hole");
    p[0] ^= 0xff; /* a private write stays in the mapping */

    errno = 0;
    CHECK(mremap(p, 2 * page, 3 * page, 0) == MAP_FAILED && errno == EFAULT,
          "in-place growth of a private file mapping is refused");
    errno = 0;
    CHECK(mremap(p, 2 * page, 3 * page, MREMAP_MAYMOVE) == MAP_FAILED &&
              errno == EFAULT,
          "moving growth of a private file mapping is refused");
    CHECK(range_mapped(p, 2 * page) && !range_mapped(p + 2 * page, page),
          "a refused growth leaves the mapping as it was");

    unsigned char *r = mremap(p, 2 * page, 2 * page,
                              MREMAP_MAYMOVE | MREMAP_FIXED, p + 2 * page);
    CHECK(r == p + 2 * page, "move a private file mapping without growth");
    CHECK(r[0] == (unsigned char)(pattern_byte(0, 8) ^ 0xff),
          "the private write moved with the mapping");
    CHECK(matches(r + 1, 2 * page - 1, 1, 8), "the file bytes moved");
    r = mremap(r, 2 * page, page, 0);
    CHECK(r == p + 2 * page, "shrink a private file mapping");
    CHECK(munmap(r, page) == 0, "munmap");
    close(fd);
    unlink(path);
}

static void test_shared_file(void) {
    const char *path = "/tmp/mremap-shared.bin";
    int fd = make_file(path, 3 * page, 9);
    unsigned char *blocker = map_anon(page);
    unsigned char *p = mmap(NULL, page, PROT_READ | PROT_WRITE, MAP_SHARED,
                            fd, 0);
    CHECK(p != MAP_FAILED, "mmap shared file");
    unsigned char *r = mremap(p, page, 3 * page, MREMAP_MAYMOVE);
    CHECK(r != MAP_FAILED, "grow shared file mapping");
    CHECK(matches(r, 3 * page, 0, 9),
          "grown shared file mapping shows the file bytes");
    r[2 * page + 5] = 0x5a;
    CHECK(msync(r, 3 * page, MS_SYNC) == 0, "msync");
    unsigned char byte = 0;
    CHECK(pread(fd, &byte, 1, 2 * page + 5) == 1, "pread");
    CHECK(byte == 0x5a, "store through the grown mapping reached the file");
    CHECK(munmap(r, 3 * page) == 0, "munmap shared file mapping");
    CHECK(munmap(blocker, page) == 0, "munmap blocker");
    close(fd);
    unlink(path);
}

static void test_madvise(void) {
    unsigned char *p = map_anon(2 * page);
    fill(p, 2 * page, 0, 10);
    static const int hints[] = {MADV_NORMAL, MADV_RANDOM, MADV_SEQUENTIAL,
                                MADV_WILLNEED};
    for (size_t i = 0; i < sizeof hints / sizeof hints[0]; i++) {
        CHECK(madvise(p, 2 * page, hints[i]) == 0, "madvise advice %d",
              hints[i]);
        CHECK(posix_madvise(p, 2 * page, hints[i]) == 0,
              "posix_madvise advice %d", hints[i]);
    }
    CHECK(matches(p, 2 * page, 0, 10), "advice did not change the data");
    /* POSIX_MADV_DONTNEED has no effect on data semantics. */
    CHECK(posix_madvise(p, 2 * page, POSIX_MADV_DONTNEED) == 0,
          "posix_madvise POSIX_MADV_DONTNEED");
    CHECK(matches(p, 2 * page, 0, 10), "POSIX_MADV_DONTNEED kept the data");
    /* A length that is not a page multiple covers the partial page. */
    CHECK(madvise(p, page + 1, MADV_WILLNEED) == 0, "partial-page length");
    CHECK(madvise(p, 0, MADV_WILLNEED) == 0, "zero length");

    errno = 0;
    CHECK(madvise(p + 1, page, MADV_NORMAL) == -1 && errno == EINVAL,
          "madvise unaligned address");
    errno = 0;
    CHECK(madvise(p, page, 12345) == -1 && errno == EINVAL,
          "madvise unknown advice");
    CHECK(posix_madvise(p, page, 12345) == EINVAL,
          "posix_madvise unknown advice returns EINVAL");
    CHECK(posix_madvise(p + 1, page, POSIX_MADV_NORMAL) == EINVAL,
          "posix_madvise unaligned address returns EINVAL");

    CHECK(munmap(p + page, page) == 0, "unmap the second page");
    errno = 0;
    CHECK(madvise(p, 2 * page, MADV_NORMAL) == -1 && errno == ENOMEM,
          "madvise over an unmapped page");
    CHECK(posix_madvise(p, 2 * page, POSIX_MADV_WILLNEED) == ENOMEM,
          "posix_madvise over an unmapped page returns ENOMEM");
    CHECK(munmap(p, page) == 0, "munmap");
}

/* MADV_DONTNEED discards private anonymous pages, which then read as zeros,
 * and leaves shared mappings' content; a private file mapping, which Kandelo
 * cannot reread, is refused. Other advice with a data effect Kandelo does not
 * implement is refused rather than accepted without its effect. */
static void test_madvise_dontneed(void) {
    unsigned char *p = map_anon(3 * page);
    fill(p, 3 * page, 0, 11);
    CHECK(madvise(p + page, page, MADV_DONTNEED) == 0, "MADV_DONTNEED");
    CHECK(matches(p, page, 0, 11), "the page before is kept");
    CHECK(all_zero(p + page, page), "the discarded page reads as zeros");
    CHECK(matches(p + 2 * page, page, 2 * page, 11), "the page after is kept");
    p[page] = 5;
    CHECK(p[page] == 5, "a discarded page is writable again");

    /* MADV_FREE may keep the contents of private anonymous memory. */
    CHECK(madvise(p, page, MADV_FREE) == 0, "MADV_FREE");
    static const int refused[] = {MADV_REMOVE, MADV_DONTFORK, MADV_WIPEONFORK,
                                  MADV_HWPOISON, MADV_SOFT_OFFLINE};
    for (size_t i = 0; i < sizeof refused / sizeof refused[0]; i++) {
        errno = 0;
        CHECK(madvise(p, page, refused[i]) == -1 && errno == EINVAL,
              "unimplemented advice %d is refused", refused[i]);
    }
    CHECK(matches(p, page, 0, 11), "refused advice changed nothing");
    CHECK(munmap(p, 3 * page) == 0, "munmap");

    unsigned char *shared = mmap(NULL, page, PROT_READ | PROT_WRITE,
                                 MAP_SHARED | MAP_ANONYMOUS, -1, 0);
    CHECK(shared != MAP_FAILED, "mmap shared");
    fill(shared, page, 0, 12);
    CHECK(madvise(shared, page, MADV_DONTNEED) == 0, "shared MADV_DONTNEED");
    CHECK(matches(shared, page, 0, 12), "a shared mapping keeps its content");
    errno = 0;
    CHECK(madvise(shared, page, MADV_FREE) == -1 && errno == EINVAL,
          "MADV_FREE of a shared mapping");
    CHECK(munmap(shared, page) == 0, "munmap shared");

    const char *path = "/tmp/madvise-private.bin";
    int fd = make_file(path, page, 13);
    unsigned char *f = mmap(NULL, page, PROT_READ | PROT_WRITE, MAP_PRIVATE,
                            fd, 0);
    CHECK(f != MAP_FAILED, "mmap private file");
    f[0] ^= 0xff;
    errno = 0;
    CHECK(madvise(f, page, MADV_DONTNEED) == -1 && errno == EINVAL,
          "MADV_DONTNEED of a private file mapping is refused");
    CHECK(f[0] == (unsigned char)(pattern_byte(0, 13) ^ 0xff),
          "the refused discard kept the private write");
    CHECK(munmap(f, page) == 0, "munmap file");
    close(fd);
    unlink(path);

    /* The brk heap is private anonymous memory too. Kandelo's compact
     * process layouts start the mmap area at the program break, so the break
     * can grow only while no mapping sits above it; the unit tests cover the
     * heap's classification. */
    uintptr_t start = (uintptr_t)syscall(SYS_brk, 0);
    unsigned char *heap = (unsigned char *)((start + page - 1) &
                                            ~(uintptr_t)(page - 1));
    uintptr_t want = (uintptr_t)heap + page;
    if ((uintptr_t)syscall(SYS_brk, want) == want) {
        fill(heap, page, 0, 14);
        CHECK(madvise(heap, page, MADV_DONTNEED) == 0, "heap MADV_DONTNEED");
        CHECK(all_zero(heap, page), "a discarded heap page reads as zeros");
        CHECK((uintptr_t)syscall(SYS_brk, start) == start, "restore the break");
    }
}

/* The kernel validates mprotect requests (it cannot enforce protection).
 * The raw syscall keeps this independent of whether libc links mprotect. */
static void test_mprotect_validation(void) {
    unsigned char *p = map_anon(2 * page);
    CHECK(syscall(SYS_mprotect, p, 2 * page, PROT_READ | PROT_WRITE) == 0,
          "mprotect of a mapping");
    errno = 0;
    CHECK(syscall(SYS_mprotect, p, page, 0x40 | PROT_READ) == -1 && errno == EINVAL,
          "unknown protection bits");
    CHECK(munmap(p + page, page) == 0, "unmap the second page");
    errno = 0;
    CHECK(syscall(SYS_mprotect, p, 2 * page, PROT_READ | PROT_WRITE) == -1 &&
              errno == ENOMEM,
          "mprotect over an unmapped page");
    CHECK(munmap(p, page) == 0, "munmap");
}

int main(void) {
    page = sysconf(_SC_PAGESIZE);
    CHECK(page > 0, "sysconf(_SC_PAGESIZE)");
    test_shrink();
    test_grow_in_place();
    test_grow_suffix_in_place();
    test_grow_blocked();
    test_grow_move();
    test_fixed();
    test_errors();
    test_private_file();
    test_shared_file();
    test_madvise();
    test_madvise_dontneed();
    test_mprotect_validation();
    puts("MREMAP_MADVISE_PASS");
    return 0;
}
