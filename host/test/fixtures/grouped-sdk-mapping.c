#define _GNU_SOURCE
#include <errno.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#define PAGE 65536
#define CHECK(expr) do { if (!(expr)) { \
    fprintf(stderr, "FAIL line=%d errno=%d: %s\n", __LINE__, errno, #expr); \
    return 1; } ++checks; } while (0)

int main(int argc, char **argv) {
    int checks = 0;
    CHECK(argc == 2 && (!strcmp(argv[1], "ordinary") || !strcmp(argv[1], "grouped")));
    unsigned char *heap = malloc(3 * PAGE);
    CHECK(heap != NULL);
    memset(heap, 0x63, 3 * PAGE);
    volatile unsigned char *observed = heap;
    unsigned int sum = 0;
    for (size_t i = 0; i < 3 * PAGE; ++i) sum += observed[i];
    CHECK(sum == 3 * PAGE * 0x63u);
    free(heap);
    puts("heap-ok");

    unsigned char *p = mmap(NULL, 2 * PAGE, PROT_READ | PROT_WRITE,
                            MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    CHECK(p != MAP_FAILED);
    CHECK(p[0] == 0 && p[2 * PAGE - 1] == 0);
    _Atomic uint32_t *word = (_Atomic uint32_t *)(p + PAGE);
    atomic_store(word, 17);
    CHECK(atomic_fetch_add(word, 4) == 17 && atomic_load(word) == 21);
    p[0] = 'x';
    CHECK(mprotect(p, PAGE, PROT_READ) == 0);
    int fds[2];
    CHECK(pipe(fds) == 0);
    CHECK(write(fds[1], p, 1) == 1);
    errno = 0;
    if (!strcmp(argv[1], "ordinary")) {
        /* Ordinary mprotect is documented as partial. Keep that limitation
         * visible while comparing the remaining common mapping operations. */
        CHECK(read(fds[0], p, 1) == 1 && p[0] == 'x');
        puts("ordinary-protection-partial");
        CHECK(write(fds[1], p, 1) == 1);
    } else {
        CHECK(read(fds[0], p, 1) == -1 && errno == EFAULT);
    }
    CHECK(mprotect(p, PAGE, PROT_READ | PROT_WRITE) == 0);
    p[0] = 0;
    CHECK(read(fds[0], p, 1) == 1 && p[0] == 'x');
    CHECK(close(fds[0]) == 0 && close(fds[1]) == 0);
    puts("protection-io-ok");

    p = mremap(p, 2 * PAGE, 3 * PAGE, MREMAP_MAYMOVE);
    CHECK(p != MAP_FAILED);
    CHECK(p[0] == 'x' && atomic_load((_Atomic uint32_t *)(p + PAGE)) == 21);
    CHECK(p[3 * PAGE - 1] == 0);
    unsigned char *blocker = mmap(p + 3 * PAGE, PAGE, PROT_READ | PROT_WRITE,
                                  MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    CHECK(blocker == p + 3 * PAGE);
    blocker[0] = 'b';
    unsigned char *old = p;
    p = mremap(p, 3 * PAGE, 4 * PAGE, MREMAP_MAYMOVE);
    CHECK(p != MAP_FAILED && p != old);
    CHECK(p[0] == 'x' && atomic_load((_Atomic uint32_t *)(p + PAGE)) == 21);
    CHECK(p[4 * PAGE - 1] == 0 && blocker[0] == 'b');
    CHECK(munmap(blocker, PAGE) == 0);
    puts("moving-remap-ok");
    memset(p, 0xa5, 4 * PAGE);
    CHECK(munmap(p + PAGE, PAGE) == 0);
    CHECK(mmap(p + PAGE, PAGE, PROT_READ | PROT_WRITE,
               MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0) == p + PAGE);
    CHECK(p[0] == 0xa5 && p[PAGE] == 0 && p[2 * PAGE - 1] == 0 && p[4 * PAGE - 1] == 0xa5);
    CHECK(munmap(p, 4 * PAGE) == 0);
    p = mmap(NULL, 3 * PAGE, PROT_READ | PROT_WRITE,
             MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    CHECK(p != MAP_FAILED);
    unsigned char nonzero = 0;
    for (size_t i = 0; i < 3 * PAGE; ++i) nonzero |= p[i];
    CHECK(nonzero == 0);
    CHECK(munmap(p, 3 * PAGE) == 0);
    printf("grouped-sdk-mapping PASS checks=%d\n", checks);
    return 0;
}
