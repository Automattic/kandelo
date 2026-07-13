#include <errno.h>
#include <stdio.h>
#include <time.h>

int main(void) {
    clockid_t clock_id = 0;
    struct timespec ts = {0};

    /* POSIX returns the error number directly from clock_getcpuclockid(). */
    int rc = clock_getcpuclockid(-2, &clock_id);
    if (rc != ESRCH) {
        fprintf(stderr,
                "FAIL clock_getcpuclockid(-2): rc=%d expected=%d clock=%d\n",
                rc, ESRCH, (int)clock_id);
        return 1;
    }

    errno = 0;
    if (clock_gettime((clockid_t)10, &ts) != -1 || errno != EINVAL) {
        fprintf(stderr, "FAIL clock_gettime(10): errno=%d expected=%d\n",
                errno, EINVAL);
        return 1;
    }

    errno = 0;
    if (clock_getres((clockid_t)10, &ts) != -1 || errno != EINVAL) {
        fprintf(stderr, "FAIL clock_getres(10): errno=%d expected=%d\n",
                errno, EINVAL);
        return 1;
    }

    puts("PASS clock id validation");
    return 0;
}
