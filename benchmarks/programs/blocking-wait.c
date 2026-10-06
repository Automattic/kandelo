/* blocking-wait.c — Measure the cost of timed blocking waits.
 *
 * WHY this exists separately from syscall-latency.c: that benchmark measures
 * getpid(), which never blocks and never arms a timeout. Nothing else in the
 * suite exercises the path a timed poll/select/epoll_wait takes — arm a
 * deadline, retry while it has not expired, report the timeout when it has —
 * so a change to that path could regress with every benchmark still green.
 *
 * Two shapes matter and cost very different amounts:
 *
 *   *_ready_us_per_op    the call finds its fd ready and returns at once. This
 *                        is the common case in a server loop, and it pays for
 *                        arming and retiring a deadline it never uses.
 *   *_timeout_us_per_op  the call waits out its whole timeout. This is the
 *                        full cycle, including however many times the runtime
 *                        re-checks readiness before the deadline passes.
 *
 * The timeout figures include the timeout itself, so they are dominated by it
 * (a 1 ms timeout cannot cost less than 1 ms). They are still worth tracking:
 * a regression in retry overhead shows up as the figure drifting away from
 * the timeout it was asked for.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <poll.h>
#include <sys/select.h>
#include <sys/epoll.h>
#include <sys/time.h>

#define READY_ITERATIONS 2000
#define TIMEOUT_ITERATIONS 200
#define TIMEOUT_MS 1

static long long now_us(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (long long)tv.tv_sec * 1000000LL + tv.tv_usec;
}

static void report(const char *name, long long elapsed_us, int iterations) {
    printf("%s=%f\n", name, (double)elapsed_us / iterations);
}

int main(void) {
    int idle[2];
    int ready[2];
    if (pipe(idle) != 0 || pipe(ready) != 0) {
        fprintf(stderr, "blocking-wait: pipe failed\n");
        return 1;
    }
    /* One byte that is never consumed keeps `ready[0]` readable for every
     * iteration, so the ready-path measurements do not drift as the pipe
     * drains. */
    if (write(ready[1], "x", 1) != 1) {
        fprintf(stderr, "blocking-wait: seed write failed\n");
        return 1;
    }

    struct pollfd pfd;
    long long t0, t1;

    /* poll, fd already readable, finite timeout. */
    pfd.fd = ready[0];
    pfd.events = POLLIN;
    for (int i = 0; i < 50; i++) poll(&pfd, 1, TIMEOUT_MS);
    t0 = now_us();
    for (int i = 0; i < READY_ITERATIONS; i++) {
        pfd.fd = ready[0];
        pfd.events = POLLIN;
        pfd.revents = 0;
        if (poll(&pfd, 1, TIMEOUT_MS) != 1) {
            fprintf(stderr, "blocking-wait: ready poll did not report ready\n");
            return 1;
        }
    }
    t1 = now_us();
    report("poll_ready_us_per_op", t1 - t0, READY_ITERATIONS);

    /* poll, nothing readable, waits out the whole timeout. */
    t0 = now_us();
    for (int i = 0; i < TIMEOUT_ITERATIONS; i++) {
        pfd.fd = idle[0];
        pfd.events = POLLIN;
        pfd.revents = 0;
        if (poll(&pfd, 1, TIMEOUT_MS) != 0) {
            fprintf(stderr, "blocking-wait: idle poll did not time out\n");
            return 1;
        }
    }
    t1 = now_us();
    report("poll_timeout_us_per_op", t1 - t0, TIMEOUT_ITERATIONS);

    /* select, nothing readable, waits out the whole timeout. */
    t0 = now_us();
    for (int i = 0; i < TIMEOUT_ITERATIONS; i++) {
        fd_set rfds;
        struct timeval tv;
        FD_ZERO(&rfds);
        FD_SET(idle[0], &rfds);
        tv.tv_sec = 0;
        tv.tv_usec = TIMEOUT_MS * 1000;
        if (select(idle[0] + 1, &rfds, NULL, NULL, &tv) != 0) {
            fprintf(stderr, "blocking-wait: select did not time out\n");
            return 1;
        }
    }
    t1 = now_us();
    report("select_timeout_us_per_op", t1 - t0, TIMEOUT_ITERATIONS);

    /* epoll_wait, fd already readable, finite timeout. */
    int epfd = epoll_create1(0);
    if (epfd < 0) {
        fprintf(stderr, "blocking-wait: epoll_create1 failed\n");
        return 1;
    }
    struct epoll_event interest;
    memset(&interest, 0, sizeof(interest));
    interest.events = EPOLLIN;
    interest.data.fd = ready[0];
    if (epoll_ctl(epfd, EPOLL_CTL_ADD, ready[0], &interest) != 0) {
        fprintf(stderr, "blocking-wait: epoll_ctl failed\n");
        return 1;
    }
    struct epoll_event events[4];
    for (int i = 0; i < 50; i++) epoll_wait(epfd, events, 4, TIMEOUT_MS);
    t0 = now_us();
    for (int i = 0; i < READY_ITERATIONS; i++) {
        if (epoll_wait(epfd, events, 4, TIMEOUT_MS) != 1) {
            fprintf(stderr, "blocking-wait: ready epoll_wait missed its fd\n");
            return 1;
        }
    }
    t1 = now_us();
    report("epoll_ready_us_per_op", t1 - t0, READY_ITERATIONS);

    close(epfd);
    close(idle[0]);
    close(idle[1]);
    close(ready[0]);
    close(ready[1]);
    return 0;
}
