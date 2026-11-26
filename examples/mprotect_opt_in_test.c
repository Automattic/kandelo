/*
 * mprotect() on Kandelo.
 *
 * Built without KANDELO_TEST_MPROTECT, the program references no public
 * mprotect and needs no opt-in: it checks that musl's own users of the
 * internal __mprotect (mallocng's meta areas, pthread_create's stacks) work.
 *
 * Built with -DKANDELO_TEST_MPROTECT, it calls mprotect() and must link
 * -lkandelo-mprotect: requests that keep read and write access succeed and
 * requests that would remove access fail with ENOTSUP.
 *
 * Prints MPROTECT_TEST_PASS; "FAIL ..." and exit 1 otherwise.
 */
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#define CHECK(cond, what)                                                  \
    do {                                                                   \
        if (!(cond)) {                                                     \
            printf("FAIL %s (errno=%d %s)\n", what, errno, strerror(errno)); \
            exit(1);                                                       \
        }                                                                  \
    } while (0)

static void *thread_main(void *arg) {
    volatile char buf[4096];
    memset((char *)buf, 1, sizeof buf);
    return (char *)arg + buf[0];
}

static void libc_internals(void) {
    /* Enough small allocations to need several mallocng meta areas, which
     * mallocng makes accessible with __mprotect. */
    static void *blocks[20000];
    for (int i = 0; i < 20000; i++) {
        blocks[i] = malloc(16 + i % 200);
        CHECK(blocks[i] != NULL, "malloc");
        memset(blocks[i], i, 16);
    }
    for (int i = 0; i < 20000; i++) free(blocks[i]);
    void *big = malloc(8 << 20);
    CHECK(big != NULL, "large malloc");
    memset(big, 3, 8 << 20);
    free(big);

    /* pthread_create maps the stack PROT_NONE and opens it with __mprotect. */
    pthread_t t;
    void *ret = NULL;
    char token;
    CHECK(pthread_create(&t, NULL, thread_main, &token) == 0, "pthread_create");
    CHECK(pthread_join(t, &ret) == 0, "pthread_join");
    CHECK(ret == &token + 1, "thread result");
}

#ifdef KANDELO_TEST_MPROTECT
static void opt_in(void) {
    long page = sysconf(_SC_PAGESIZE);
    unsigned char *p = mmap(NULL, 2 * page, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    CHECK(p != MAP_FAILED, "mmap PROT_NONE");
    CHECK(mprotect(p, 2 * page, PROT_READ | PROT_WRITE) == 0, "commit read/write");
    p[0] = 1;
    p[2 * page - 1] = 2;
    CHECK(mprotect(p, page, PROT_READ | PROT_WRITE | PROT_EXEC) == 0, "read/write/exec");

    static const int restrictive[] = {PROT_NONE, PROT_READ, PROT_WRITE, PROT_EXEC,
                                      PROT_READ | PROT_EXEC, PROT_WRITE | PROT_EXEC};
    for (size_t i = 0; i < sizeof restrictive / sizeof restrictive[0]; i++) {
        errno = 0;
        CHECK(mprotect(p, page, restrictive[i]) == -1 && errno == ENOTSUP,
              "a request that removes access is ENOTSUP");
    }
    CHECK(p[0] == 1 && p[2 * page - 1] == 2, "refused requests changed nothing");
    p[0] = 3;
    errno = 0;
    CHECK(mprotect(p, page, 0x40 | PROT_READ | PROT_WRITE) == -1 && errno == EINVAL,
          "unknown protection bits are EINVAL");
    CHECK(munmap(p, 2 * page) == 0, "munmap");
}
#endif

int main(void) {
    libc_internals();
#ifdef KANDELO_TEST_MPROTECT
    opt_in();
#endif
    puts("MPROTECT_TEST_PASS");
    return 0;
}
