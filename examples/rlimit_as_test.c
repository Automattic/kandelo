/*
 * RLIMIT_AS must describe the address space a Kandelo process actually has.
 *
 * A process here is a bounded Wasm linear memory, not the lazily-committed
 * virtual range RLIMIT_AS describes on Linux, and the ceiling differs by host:
 * the browser's constrained memory profile gives each process 256 MiB, the
 * desktop profile 1 GiB. A guest cannot discover that bound any other way, so
 * reporting RLIM_INFINITY invites a program to size one large allocation from
 * it and then take an ENOMEM it had no way to anticipate. (That is exactly how
 * TyrQuake died on iOS: its 256 MiB default heap is the whole address space
 * there.)
 *
 * Prints the reported limit so the caller can check it tracks the ceiling the
 * host configured, then proves the number is real rather than decorative.
 */
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>

int
main(void)
{
    struct rlimit address_space;

    if (getrlimit(RLIMIT_AS, &address_space) != 0) {
        perror("getrlimit(RLIMIT_AS)");
        return 1;
    }
    printf("RLIMIT_AS soft=%llu hard=%llu\n",
           (unsigned long long)address_space.rlim_cur,
           (unsigned long long)address_space.rlim_max);

    if (address_space.rlim_cur == RLIM_INFINITY
        || address_space.rlim_max == RLIM_INFINITY) {
        printf("RLIMIT_AS_FAIL: reported as unbounded\n");
        return 1;
    }

    /* The bound must be the one that applies: the whole space cannot be
     * allocated (this program, its stack, and the host's control pages are
     * already inside it), while a small fraction of it can. */
    void *whole = malloc((size_t)address_space.rlim_cur);
    if (whole != NULL) {
        printf("RLIMIT_AS_FAIL: allocated the entire reported address space\n");
        free(whole);
        return 1;
    }

    size_t eighth = (size_t)(address_space.rlim_cur / 8);
    void *part = malloc(eighth);
    if (part == NULL) {
        printf("RLIMIT_AS_FAIL: could not allocate %zu bytes, an eighth of "
               "the reported address space\n", eighth);
        return 1;
    }
    free(part);

    printf("RLIMIT_AS_PASS\n");
    return 0;
}
