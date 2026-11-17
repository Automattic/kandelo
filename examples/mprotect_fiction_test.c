/*
 * The declared mprotect fiction (sdk/fictions/mprotect.toml).
 *
 * Built with a fiction selection (--kandelo-fiction=mprotect:... or
 * KANDELO_FICTIONS) or with only -lkandelo-mprotect, and told what that
 * selection should do:
 *
 *   -DEXPECT_PROT_NONE=0|1    requests without PROT_READ are accepted
 *   -DEXPECT_PROT_NONE_MAX=N  ...up to N bytes after page rounding (0: any)
 *   -DEXPECT_READ_ONLY=0|1    requests with PROT_READ, without PROT_WRITE
 *   -DEXPECT_READ_ONLY_MAX=N
 *   -DWITH_FORK               also fork, so the program is fork-instrumented
 *
 * It checks every class and limit, that an accepted request changes nothing
 * (the memory stays readable and writable: that is the fiction), that
 * requests keeping read and write access always succeed, and that the
 * kernel logged exactly one record for this process when it accepted any
 * restrictive request, and none otherwise.
 *
 * Prints MPROTECT_FICTION_PASS; "FAIL ..." and exit 1 otherwise.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef EXPECT_PROT_NONE
#define EXPECT_PROT_NONE 0
#endif
#ifndef EXPECT_PROT_NONE_MAX
#define EXPECT_PROT_NONE_MAX 0
#endif
#ifndef EXPECT_READ_ONLY
#define EXPECT_READ_ONLY 0
#endif
#ifndef EXPECT_READ_ONLY_MAX
#define EXPECT_READ_ONLY_MAX 0
#endif

#define CHECK(cond, ...)                                                   \
    do {                                                                   \
        if (!(cond)) {                                                     \
            printf("FAIL ");                                               \
            printf(__VA_ARGS__);                                           \
            printf(" (errno=%d %s)\n", errno, strerror(errno));            \
            exit(1);                                                       \
        }                                                                  \
    } while (0)

static int accepted_restrictive;

static long page;

static int expected(int prot, size_t len) {
    size_t rounded = (len + (size_t)page - 1) / (size_t)page * (size_t)page;
    if ((prot & (PROT_READ | PROT_WRITE)) == (PROT_READ | PROT_WRITE)) return 1;
    int accept = (prot & PROT_READ) ? EXPECT_READ_ONLY : EXPECT_PROT_NONE;
    unsigned long long max = (prot & PROT_READ) ? EXPECT_READ_ONLY_MAX : EXPECT_PROT_NONE_MAX;
    return accept && (max == 0 || rounded <= max);
}

static void try_request(unsigned char *p, size_t len, int prot) {
    int want = expected(prot, len);
    errno = 0;
    int r = mprotect(p, len, prot);
    if (want) {
        CHECK(r == 0, "mprotect(%zu, %#x) should succeed", len, prot);
        if ((prot & (PROT_READ | PROT_WRITE)) != (PROT_READ | PROT_WRITE))
            accepted_restrictive = 1;
    } else {
        CHECK(r == -1 && errno == ENOTSUP, "mprotect(%zu, %#x) should be ENOTSUP", len, prot);
    }
    /* Either way access is unchanged: Kandelo has no page protection. */
    p[0]++;
    p[len - 1]++;
    CHECK(mprotect(p, len, PROT_READ | PROT_WRITE) == 0, "restore read/write");
}

/* Records in /dev/kmsg naming this process's unenforced mprotect. */
static int unenforced_records(void) {
    char needle[64];
    snprintf(needle, sizeof needle, "pid %d mprotect(", (int)getpid());
    int fd = open("/dev/kmsg", O_RDONLY | O_NONBLOCK);
    CHECK(fd >= 0, "open /dev/kmsg");
    int count = 0;
    char record[2048];
    for (;;) {
        ssize_t n = read(fd, record, sizeof record - 1);
        if (n < 0 && errno == EPIPE) continue; /* overwritten records */
        if (n < 0) {
            CHECK(errno == EAGAIN, "read /dev/kmsg");
            break;
        }
        record[n] = 0;
        if (strstr(record, needle) && strstr(record, "is not enforced")) count++;
    }
    close(fd);
    return count;
}

int main(void) {
    page = sysconf(_SC_PAGESIZE);
    size_t span = 4 * (size_t)page;
    unsigned char *p = mmap(NULL, span, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    CHECK(p != MAP_FAILED, "mmap");
    CHECK(mprotect(p, span, PROT_READ | PROT_WRITE) == 0, "commit read/write");
    CHECK(mprotect(p, page, PROT_READ | PROT_WRITE | PROT_EXEC) == 0, "read/write/exec");
    memset(p, 7, span);

    static const int restrictive[] = {PROT_NONE, PROT_WRITE, PROT_EXEC, PROT_WRITE | PROT_EXEC,
                                      PROT_READ, PROT_READ | PROT_EXEC};
    for (size_t i = 0; i < sizeof restrictive / sizeof restrictive[0]; i++) {
        for (size_t pages = 1; pages <= 4; pages *= 2)
            try_request(p, pages * (size_t)page, restrictive[i]);
        /* A short request is rounded out to whole pages first. */
        try_request(p, 1, restrictive[i]);
    }
    CHECK(p[page / 2] == 7, "untouched bytes kept their value");

    errno = 0;
    CHECK(mprotect(p, page, 0x40 | PROT_NONE) == -1 && errno == EINVAL,
          "unknown protection bits are EINVAL");

#ifdef WITH_FORK
    pid_t child = fork();
    CHECK(child >= 0, "fork");
    if (child == 0) _exit(0);
    int status = 0;
    CHECK(waitpid(child, &status, 0) == child && WIFEXITED(status), "waitpid");
#endif

    int records = unenforced_records();
    CHECK(records == accepted_restrictive,
          "%d kernel log records for %d accepted restrictive requests", records, accepted_restrictive);
    CHECK(munmap(p, span) == 0, "munmap");
    puts("MPROTECT_FICTION_PASS");
    return 0;
}
