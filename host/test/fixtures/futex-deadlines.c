#define _GNU_SOURCE
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

/* Linux-compatible futex operations exposed by Kandelo. */
enum { WAIT = 0, WAIT_BITSET = 9, PRIVATE = 128, REALTIME = 256 };
static uint32_t word;

static int expired(const struct timespec *now, const struct timespec *deadline) {
    return now->tv_sec > deadline->tv_sec ||
        (now->tv_sec == deadline->tv_sec && now->tv_nsec >= deadline->tv_nsec);
}

static int wait_until(clockid_t clock, int flags) {
    struct timespec deadline, after;
    if (clock_gettime(clock, &deadline)) return 1;
    deadline.tv_nsec += 20000000;
    if (deadline.tv_nsec >= 1000000000) {
        deadline.tv_nsec -= 1000000000;
        deadline.tv_sec++;
    }
    errno = 0;
    long result = syscall(SYS_futex, &word, WAIT_BITSET | PRIVATE | flags,
        0, &deadline, NULL, UINT32_MAX);
    if (result != -1 || errno != ETIMEDOUT) {
        fprintf(stderr, "clock %d future deadline: result=%ld errno=%d\n", clock, result, errno);
        return 1;
    }
    if (clock_gettime(clock, &after) || !expired(&after, &deadline)) {
        fprintf(stderr, "clock %d returned before its deadline\n", clock);
        return 1;
    }
    struct timespec past = {0};
    errno = 0;
    result = syscall(SYS_futex, &word, WAIT_BITSET | flags,
        0, &past, NULL, UINT32_MAX);
    if (result != -1 || errno != ETIMEDOUT) {
        fprintf(stderr, "clock %d expired deadline: result=%ld errno=%d\n", clock, result, errno);
        return 1;
    }
    return 0;
}

int main(void) {
    if (wait_until(CLOCK_MONOTONIC, 0) || wait_until(CLOCK_REALTIME, REALTIME)) return 1;
    struct timespec before, after, duration = {.tv_nsec = 20000000};
    if (clock_gettime(CLOCK_MONOTONIC, &before)) return 1;
    errno = 0;
    long result = syscall(SYS_futex, &word, WAIT | PRIVATE, 0, &duration, NULL, 0);
    if (result != -1 || errno != ETIMEDOUT) {
        fprintf(stderr, "relative wait: result=%ld errno=%d\n", result, errno);
        return 1;
    }
    before.tv_nsec += duration.tv_nsec;
    if (before.tv_nsec >= 1000000000) { before.tv_nsec -= 1000000000; before.tv_sec++; }
    if (clock_gettime(CLOCK_MONOTONIC, &after) || !expired(&after, &before)) {
        fprintf(stderr, "relative wait returned before its duration\n");
        return 1;
    }
    puts("FUTEX_DEADLINES_PASS");
    return 0;
}
