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

    /* select, fd already readable, finite timeout.
     *
     * Appended after the existing sections on purpose: each section is timed
     * in its own window, so adding one here leaves the earlier numbers
     * comparable with runs taken before it existed. */
    for (int i = 0; i < 50; i++) {
        fd_set rfds;
        struct timeval tv;
        FD_ZERO(&rfds);
        FD_SET(ready[0], &rfds);
        tv.tv_sec = 0;
        tv.tv_usec = TIMEOUT_MS * 1000;
        select(ready[0] + 1, &rfds, NULL, NULL, &tv);
    }
    t0 = now_us();
    for (int i = 0; i < READY_ITERATIONS; i++) {
        fd_set rfds;
        struct timeval tv;
        FD_ZERO(&rfds);
        FD_SET(ready[0], &rfds);
        tv.tv_sec = 0;
        tv.tv_usec = TIMEOUT_MS * 1000;
        if (select(ready[0] + 1, &rfds, NULL, NULL, &tv) != 1) {
            fprintf(stderr, "blocking-wait: ready select did not report ready\n");
            return 1;
        }
    }
    t1 = now_us();
    report("select_ready_us_per_op", t1 - t0, READY_ITERATIONS);

    /* ---- Registered-interest sweep, and an order control ----
     *
     * WHY: the metrics above register exactly one interest, so they cannot
     * tell per-call work proportional to the number of *registered* interests
     * apart from per-call work proportional to the number of *ready* results.
     * A wait implementation that walks its whole interest set on every call
     * costs more as the set grows even when one fd is ready throughout; one
     * that returns as soon as it has a ready result does not. The sections
     * below hold the ready count at exactly one and vary only the count of
     * registered-but-idle fds, so a delta that rises with IDLE_MAX localizes
     * the cost to interest-set traversal and a flat delta rules it out.
     *
     * The trailing `poll_ready_late` is a control for a different explanation
     * of the same shape. Every section runs in one process in a fixed order,
     * so a cost that accumulates over a process's blocking-wait history —
     * a growing queue, a registry that is never pruned — would also make the
     * later sections (epoll_ready, select_ready) look slower than the earlier
     * one (poll_ready) with no interest-set mechanism involved. Repeating the
     * *first* measurement last separates the two: if poll_ready_late is close
     * to poll_ready, position is not the cause; if it drifts, it is.
     */
#define IDLE_MAX 64

    static int idle_fds[IDLE_MAX][2];
    int idle_made = 0;
    for (; idle_made < IDLE_MAX; idle_made++) {
        if (pipe(idle_fds[idle_made]) != 0) break;
    }

    const int sweep[] = {0, 16, 64};
    for (unsigned s = 0; s < sizeof(sweep) / sizeof(sweep[0]); s++) {
        int n = sweep[s];
        if (n > idle_made) continue;
        char name[64];

        /* epoll: n registered-but-idle interests plus the one ready fd. */
        int sepfd = epoll_create1(0);
        if (sepfd < 0) {
            fprintf(stderr, "blocking-wait: sweep epoll_create1 failed\n");
            return 1;
        }
        for (int i = 0; i < n; i++) {
            struct epoll_event ev;
            memset(&ev, 0, sizeof(ev));
            ev.events = EPOLLIN;
            ev.data.fd = idle_fds[i][0];
            if (epoll_ctl(sepfd, EPOLL_CTL_ADD, idle_fds[i][0], &ev) != 0) {
                fprintf(stderr, "blocking-wait: sweep epoll_ctl idle failed\n");
                return 1;
            }
        }
        struct epoll_event rev;
        memset(&rev, 0, sizeof(rev));
        rev.events = EPOLLIN;
        rev.data.fd = ready[0];
        if (epoll_ctl(sepfd, EPOLL_CTL_ADD, ready[0], &rev) != 0) {
            fprintf(stderr, "blocking-wait: sweep epoll_ctl ready failed\n");
            return 1;
        }
        struct epoll_event sevents[8];
        for (int i = 0; i < 50; i++) epoll_wait(sepfd, sevents, 8, TIMEOUT_MS);
        t0 = now_us();
        for (int i = 0; i < READY_ITERATIONS; i++) {
            if (epoll_wait(sepfd, sevents, 8, TIMEOUT_MS) != 1) {
                fprintf(stderr, "blocking-wait: sweep epoll_wait not 1 ready\n");
                return 1;
            }
        }
        t1 = now_us();
        snprintf(name, sizeof(name), "epoll_ready_idle%d_us_per_op", n);
        report(name, t1 - t0, READY_ITERATIONS);
        close(sepfd);

        /* select: the same n idle fds in the set, plus the one ready fd. */
        int maxfd = ready[0];
        for (int i = 0; i < n; i++) {
            if (idle_fds[i][0] > maxfd) maxfd = idle_fds[i][0];
        }
        for (int i = 0; i < 50; i++) {
            fd_set rfds;
            struct timeval tv;
            FD_ZERO(&rfds);
            for (int j = 0; j < n; j++) FD_SET(idle_fds[j][0], &rfds);
            FD_SET(ready[0], &rfds);
            tv.tv_sec = 0;
            tv.tv_usec = TIMEOUT_MS * 1000;
            select(maxfd + 1, &rfds, NULL, NULL, &tv);
        }
        t0 = now_us();
        for (int i = 0; i < READY_ITERATIONS; i++) {
            fd_set rfds;
            struct timeval tv;
            FD_ZERO(&rfds);
            for (int j = 0; j < n; j++) FD_SET(idle_fds[j][0], &rfds);
            FD_SET(ready[0], &rfds);
            tv.tv_sec = 0;
            tv.tv_usec = TIMEOUT_MS * 1000;
            if (select(maxfd + 1, &rfds, NULL, NULL, &tv) != 1) {
                fprintf(stderr, "blocking-wait: sweep select not 1 ready\n");
                return 1;
            }
        }
        t1 = now_us();
        snprintf(name, sizeof(name), "select_ready_idle%d_us_per_op", n);
        report(name, t1 - t0, READY_ITERATIONS);
    }

    for (int i = 0; i < idle_made; i++) {
        close(idle_fds[i][0]);
        close(idle_fds[i][1]);
    }

    /* Order control: the first measurement, repeated last. */
    for (int i = 0; i < 50; i++) {
        pfd.fd = ready[0];
        pfd.events = POLLIN;
        pfd.revents = 0;
        poll(&pfd, 1, TIMEOUT_MS);
    }
    t0 = now_us();
    for (int i = 0; i < READY_ITERATIONS; i++) {
        pfd.fd = ready[0];
        pfd.events = POLLIN;
        pfd.revents = 0;
        if (poll(&pfd, 1, TIMEOUT_MS) != 1) {
            fprintf(stderr, "blocking-wait: late ready poll did not report ready\n");
            return 1;
        }
    }
    t1 = now_us();
    report("poll_ready_late_us_per_op", t1 - t0, READY_ITERATIONS);

    close(epfd);
    close(idle[0]);
    close(idle[1]);
    close(ready[0]);
    close(ready[1]);
    return 0;
}
