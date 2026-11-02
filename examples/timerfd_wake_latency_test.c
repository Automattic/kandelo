/*
 * A timerfd expiry is a readiness event: it must end a blocked epoll_wait,
 * poll, select or read at the timer's deadline, not at whatever moment the
 * waiter happens to look again.
 *
 * Linux wakes the waiter from the timer's hrtimer callback, within the
 * timer slack (about 50 us). Kandelo's host timers are millisecond
 * grained, so this test cannot hold Kandelo to Linux's number; it holds it
 * to "the wait ended because the timer expired". Every wait below uses a
 * 5 s timeout, so a wait that is not woken by the expiry either runs to
 * that timeout or ends on some unrelated retry tick. Kandelo used to have
 * exactly that defect: the expiry was only noticed when a host retry timer
 * (10 ms for epoll and read, up to 50 ms for poll and select) re-ran the
 * wait.
 *
 * Each case arms the timer, blocks, and records how long after the
 * deadline the call returned. The median over the rounds must stay under
 * LATENCY_LIMIT_US. Cases:
 *
 *   epoll/poll/select/read  one-shot 500 us CLOCK_MONOTONIC relative timer
 *   realtime                the same on CLOCK_REALTIME
 *   abstime                 TFD_TIMER_ABSTIME on CLOCK_MONOTONIC
 *   periodic                a 2 ms interval timer observed through
 *                           epoll_wait; latency is measured from the first
 *                           expiry each read accounts for
 *   armed-while-parked      another thread arms the timer after the waiter
 *                           has already blocked in epoll_wait
 *   stress-foot-pattern     several threads each re-arming two timerfds
 *                           around pipe input, as foot's delayed rendering
 *                           does; any lost expiry is reported as a stall
 *   eventfd-thread-*        an eventfd written by another thread, the same
 *                           kind of token-less readiness source
 *
 * Output: one TIMERFD_WAKE line per case with p50/max in microseconds,
 * then TIMERFD_WAKE_PASS.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/eventfd.h>
#include <sys/select.h>
#include <sys/timerfd.h>
#include <time.h>
#include <unistd.h>

enum { ROUNDS = 15, PERIODIC_TICKS = 20 };
enum { WAIT_TIMEOUT_MS = 5000 };
/* Half the old 10 ms epoll fallback: every round woken only by that
 * fallback exceeds it, while a loaded machine's late millisecond timers
 * stay well inside it. */
enum { LATENCY_LIMIT_US = 5000 };

static void require(int ok, const char *what)
{
    if (!ok) {
        fprintf(stderr, "FAIL %s (errno %d: %s)\n", what, errno, strerror(errno));
        exit(1);
    }
}

static int64_t clock_us(clockid_t clock)
{
    struct timespec ts;
    require(clock_gettime(clock, &ts) == 0, "clock_gettime");
    return (int64_t)ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
}

static int cmp_i64(const void *a, const void *b)
{
    int64_t x = *(const int64_t *)a, y = *(const int64_t *)b;
    return x < y ? -1 : x > y;
}

static int report(const char *name, int64_t *lat, int n)
{
    qsort(lat, (size_t)n, sizeof(*lat), cmp_i64);
    int64_t p50 = lat[n / 2], max = lat[n - 1];
    int ok = p50 <= LATENCY_LIMIT_US;
    printf("TIMERFD_WAKE case=%s n=%d p50_us=%lld max_us=%lld %s\n", name, n,
           (long long)p50, (long long)max, ok ? "ok" : "SLOW");
    fflush(stdout);
    return ok;
}

enum wait_api { API_EPOLL, API_POLL, API_SELECT, API_READ };

/* Block until `tfd` is readable (or the call returns for another reason);
 * every API is given the same long timeout. */
static void wait_readable(enum wait_api api, int tfd, int epfd)
{
    int r;
    if (api == API_EPOLL) {
        struct epoll_event ev;
        do r = epoll_wait(epfd, &ev, 1, WAIT_TIMEOUT_MS);
        while (r < 0 && errno == EINTR);
        require(r == 1 && ev.data.fd == tfd && (ev.events & EPOLLIN), "epoll_wait ready");
    } else if (api == API_POLL) {
        struct pollfd pfd = { .fd = tfd, .events = POLLIN };
        do r = poll(&pfd, 1, WAIT_TIMEOUT_MS);
        while (r < 0 && errno == EINTR);
        require(r == 1 && (pfd.revents & POLLIN), "poll ready");
    } else if (api == API_SELECT) {
        fd_set rd;
        struct timeval tv = { .tv_sec = WAIT_TIMEOUT_MS / 1000 };
        FD_ZERO(&rd);
        FD_SET(tfd, &rd);
        do r = select(tfd + 1, &rd, NULL, NULL, &tv);
        while (r < 0 && errno == EINTR);
        require(r == 1 && FD_ISSET(tfd, &rd), "select ready");
    }
}

static uint64_t read_expirations(int tfd)
{
    uint64_t n = 0;
    ssize_t r;
    do r = read(tfd, &n, sizeof(n));
    while (r < 0 && errno == EINTR);
    require(r == (ssize_t)sizeof(n), "read timerfd");
    return n;
}

static int64_t arm_relative(int tfd, clockid_t clock, long ns)
{
    struct itimerspec its = { .it_value = { .tv_nsec = ns } };
    int64_t deadline = clock_us(clock) + ns / 1000;
    require(timerfd_settime(tfd, 0, &its, NULL) == 0, "timerfd_settime");
    return deadline;
}

static int one_shot_case(const char *name, enum wait_api api, clockid_t clock, int abstime)
{
    int64_t lat[ROUNDS];
    int tfd = timerfd_create(clock, TFD_CLOEXEC | (api == API_READ ? 0 : TFD_NONBLOCK));
    require(tfd >= 0, "timerfd_create");
    int epfd = epoll_create1(EPOLL_CLOEXEC);
    require(epfd >= 0, "epoll_create1");
    struct epoll_event ev = { .events = EPOLLIN, .data.fd = tfd };
    require(epoll_ctl(epfd, EPOLL_CTL_ADD, tfd, &ev) == 0, "epoll_ctl");

    for (int i = 0; i < ROUNDS; i++) {
        int64_t deadline;
        if (abstime) {
            struct timespec now;
            require(clock_gettime(clock, &now) == 0, "clock_gettime abs");
            now.tv_nsec += 500000;
            if (now.tv_nsec >= 1000000000) { now.tv_sec++; now.tv_nsec -= 1000000000; }
            struct itimerspec its = { .it_value = now };
            deadline = (int64_t)now.tv_sec * 1000000 + now.tv_nsec / 1000;
            require(timerfd_settime(tfd, TFD_TIMER_ABSTIME, &its, NULL) == 0,
                    "timerfd_settime abstime");
        } else {
            deadline = arm_relative(tfd, clock, 500000);
        }
        if (api != API_READ) wait_readable(api, tfd, epfd);
        uint64_t n = read_expirations(tfd);
        int64_t woke = clock_us(clock);
        require(n == 1, "one-shot expiration count");
        require(woke >= deadline, "woke before the deadline");
        lat[i] = woke - deadline;
    }
    close(epfd);
    close(tfd);
    return report(name, lat, ROUNDS);
}

static int periodic_case(void)
{
    int64_t lat[PERIODIC_TICKS];
    int tfd = timerfd_create(CLOCK_MONOTONIC, TFD_CLOEXEC | TFD_NONBLOCK);
    require(tfd >= 0, "timerfd_create periodic");
    int epfd = epoll_create1(EPOLL_CLOEXEC);
    require(epfd >= 0, "epoll_create1 periodic");
    struct epoll_event ev = { .events = EPOLLIN, .data.fd = tfd };
    require(epoll_ctl(epfd, EPOLL_CTL_ADD, tfd, &ev) == 0, "epoll_ctl periodic");

    const long period_us = 2000;
    struct itimerspec its = {
        .it_value = { .tv_nsec = period_us * 1000 },
        .it_interval = { .tv_nsec = period_us * 1000 },
    };
    int64_t start = clock_us(CLOCK_MONOTONIC);
    require(timerfd_settime(tfd, 0, &its, NULL) == 0, "timerfd_settime periodic");
    uint64_t total = 0;
    for (int i = 0; i < PERIODIC_TICKS; i++) {
        wait_readable(API_EPOLL, tfd, epfd);
        uint64_t n = read_expirations(tfd);
        int64_t woke = clock_us(CLOCK_MONOTONIC);
        require(n >= 1, "periodic expiration count");
        /* The first expiry this read accounted for: the one that made the
         * descriptor readable. A waiter that sleeps through several periods
         * is late by all of them, even though the count stays correct. */
        int64_t deadline = start + (int64_t)(total + 1) * period_us;
        total += n;
        require(woke >= deadline, "periodic woke before its deadline");
        lat[i] = woke - deadline;
    }
    close(epfd);
    close(tfd);
    return report("periodic-epoll", lat, PERIODIC_TICKS);
}

struct arm_later {
    int tfd;
    int64_t deadline;
};

static void *arm_after_delay(void *arg)
{
    struct arm_later *a = arg;
    struct timespec pause = { .tv_nsec = 20 * 1000000 };
    nanosleep(&pause, NULL);
    a->deadline = arm_relative(a->tfd, CLOCK_MONOTONIC, 500000);
    return NULL;
}

static int armed_while_parked_case(void)
{
    enum { N = 6 };
    int64_t lat[N];
    int tfd = timerfd_create(CLOCK_MONOTONIC, TFD_CLOEXEC | TFD_NONBLOCK);
    require(tfd >= 0, "timerfd_create parked");
    int epfd = epoll_create1(EPOLL_CLOEXEC);
    require(epfd >= 0, "epoll_create1 parked");
    struct epoll_event ev = { .events = EPOLLIN, .data.fd = tfd };
    require(epoll_ctl(epfd, EPOLL_CTL_ADD, tfd, &ev) == 0, "epoll_ctl parked");
    for (int i = 0; i < N; i++) {
        struct arm_later a = { .tfd = tfd };
        pthread_t thread;
        require(pthread_create(&thread, NULL, arm_after_delay, &a) == 0, "pthread_create");
        wait_readable(API_EPOLL, tfd, epfd);
        int64_t woke = clock_us(CLOCK_MONOTONIC);
        require(pthread_join(thread, NULL) == 0, "pthread_join");
        require(read_expirations(tfd) == 1, "parked expiration count");
        require(woke >= a.deadline, "parked woke before the deadline");
        lat[i] = woke - a.deadline;
    }
    close(epfd);
    close(tfd);
    return report("armed-while-parked", lat, N);
}

/* An eventfd written by another thread is the same kind of readiness
 * source: no pipe token names it, and Linux wakes its waiters on every
 * write. GLib's cross-thread main-loop wakeup is exactly this. */
struct eventfd_writer {
    int fd;
    int64_t written_at;
};

static void *write_eventfd_after_delay(void *arg)
{
    struct eventfd_writer *w = arg;
    struct timespec pause = { .tv_nsec = 20 * 1000000 };
    nanosleep(&pause, NULL);
    uint64_t one = 1;
    w->written_at = clock_us(CLOCK_MONOTONIC);
    require(write(w->fd, &one, sizeof(one)) == (ssize_t)sizeof(one), "eventfd write");
    return NULL;
}

static int eventfd_case(const char *name, enum wait_api api)
{
    enum { N = 6 };
    int64_t lat[N];
    for (int i = 0; i < N; i++) {
        struct eventfd_writer w = { .fd = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK) };
        require(w.fd >= 0, "eventfd");
        int epfd = epoll_create1(EPOLL_CLOEXEC);
        require(epfd >= 0, "epoll_create1 eventfd");
        struct epoll_event ev = { .events = EPOLLIN, .data.fd = w.fd };
        require(epoll_ctl(epfd, EPOLL_CTL_ADD, w.fd, &ev) == 0, "epoll_ctl eventfd");
        pthread_t thread;
        require(pthread_create(&thread, NULL, write_eventfd_after_delay, &w) == 0,
                "pthread_create eventfd");
        wait_readable(api, w.fd, epfd);
        int64_t woke = clock_us(CLOCK_MONOTONIC);
        require(pthread_join(thread, NULL) == 0, "pthread_join eventfd");
        require(read_expirations(w.fd) == 1, "eventfd count");
        lat[i] = woke - w.written_at;
        close(epfd);
        close(w.fd);
    }
    return report(name, lat, N);
}

/*
 * Stress: foot's delayed-render pattern, many times over, in several threads
 * at once. Each thread owns an epoll set holding a pipe and two timerfds (a
 * short "lower" and a longer "upper" timer). Per round it writes the pipe,
 * then arms the lower timer, re-arms it once or twice before it can expire
 * (more input), arms the upper timer, and waits until one timer fires; then
 * it disarms both, drains the pipe and the timers, and goes again. Every
 * wait has a 5 s timeout, so a lost expiry shows up as a timeout (a stall),
 * and the worst wake latency is reported. A pass needs no stall, no wait
 * longer than STRESS_STALL_US, and a median under LATENCY_LIMIT_US.
 */
enum { STRESS_THREADS = 6, STRESS_ROUNDS = 60 };
enum { STRESS_STALL_US = 1000000 };

struct stress_result {
    int stalls;
    int n;
    int64_t lat[STRESS_ROUNDS];
};

static void *stress_thread(void *arg)
{
    struct stress_result *r = arg;
    int pipefd[2];
    require(pipe2(pipefd, O_NONBLOCK | O_CLOEXEC) == 0, "stress pipe2");
    int lower = timerfd_create(CLOCK_MONOTONIC, TFD_CLOEXEC | TFD_NONBLOCK);
    int upper = timerfd_create(CLOCK_MONOTONIC, TFD_CLOEXEC | TFD_NONBLOCK);
    int epfd = epoll_create1(EPOLL_CLOEXEC);
    require(lower >= 0 && upper >= 0 && epfd >= 0, "stress fds");
    struct epoll_event ev = { .events = EPOLLIN, .data.fd = pipefd[0] };
    require(epoll_ctl(epfd, EPOLL_CTL_ADD, pipefd[0], &ev) == 0, "stress add pipe");
    ev.data.fd = lower;
    require(epoll_ctl(epfd, EPOLL_CTL_ADD, lower, &ev) == 0, "stress add lower");
    ev.data.fd = upper;
    require(epoll_ctl(epfd, EPOLL_CTL_ADD, upper, &ev) == 0, "stress add upper");
    unsigned seed = (unsigned)(uintptr_t)r;
    for (int round = 0; round < STRESS_ROUNDS; round++) {
        char byte = 'x';
        require(write(pipefd[1], &byte, 1) == 1, "stress write");
        /* Re-arm the lower timer like repeated PTY input would. */
        int rearms = 1 + (int)(rand_r(&seed) % 3);
        int64_t lower_deadline = 0;
        for (int k = 0; k < rearms; k++)
            lower_deadline = arm_relative(lower, CLOCK_MONOTONIC,
                                          200000 + (long)(rand_r(&seed) % 1800000));
        int64_t upper_deadline = arm_relative(upper, CLOCK_MONOTONIC, 8000000);
        int64_t first_deadline = lower_deadline < upper_deadline ? lower_deadline : upper_deadline;
        int timer_seen = 0;
        while (!timer_seen) {
            struct epoll_event got[3];
            int n;
            do n = epoll_wait(epfd, got, 3, WAIT_TIMEOUT_MS);
            while (n < 0 && errno == EINTR);
            require(n >= 0, "stress epoll_wait");
            if (n == 0) {
                /* A lost expiry: the timers are armed and must have fired. */
                r->stalls++;
                break;
            }
            for (int i = 0; i < n; i++) {
                if (got[i].data.fd == pipefd[0]) {
                    char sink[64];
                    while (read(pipefd[0], sink, sizeof(sink)) > 0) {}
                } else {
                    timer_seen = 1;
                }
            }
        }
        int64_t woke = clock_us(CLOCK_MONOTONIC);
        struct itimerspec off = { 0 };
        require(timerfd_settime(lower, 0, &off, NULL) == 0, "stress disarm lower");
        require(timerfd_settime(upper, 0, &off, NULL) == 0, "stress disarm upper");
        uint64_t sink;
        (void)!read(lower, &sink, sizeof(sink));
        (void)!read(upper, &sink, sizeof(sink));
        if (timer_seen && r->n < STRESS_ROUNDS)
            r->lat[r->n++] = woke > first_deadline ? woke - first_deadline : 0;
    }
    close(epfd);
    close(lower);
    close(upper);
    close(pipefd[0]);
    close(pipefd[1]);
    return NULL;
}

static int stress_case(void)
{
    static struct stress_result results[STRESS_THREADS];
    pthread_t threads[STRESS_THREADS];
    for (int i = 0; i < STRESS_THREADS; i++)
        require(pthread_create(&threads[i], NULL, stress_thread, &results[i]) == 0,
                "stress pthread_create");
    static int64_t all[STRESS_THREADS * STRESS_ROUNDS];
    int n = 0, stalls = 0;
    for (int i = 0; i < STRESS_THREADS; i++) {
        require(pthread_join(threads[i], NULL) == 0, "stress pthread_join");
        stalls += results[i].stalls;
        for (int k = 0; k < results[i].n; k++) all[n++] = results[i].lat[k];
    }
    printf("TIMERFD_WAKE_STRESS threads=%d rounds=%d stalls=%d\n", STRESS_THREADS,
           STRESS_ROUNDS, stalls);
    if (n == 0) return 0;
    int ok = report("stress-foot-pattern", all, n);
    qsort(all, (size_t)n, sizeof(*all), cmp_i64);
    return ok && stalls == 0 && all[n - 1] <= STRESS_STALL_US;
}

int main(void)
{
    int ok = 1;
    ok &= one_shot_case("epoll", API_EPOLL, CLOCK_MONOTONIC, 0);
    ok &= one_shot_case("poll", API_POLL, CLOCK_MONOTONIC, 0);
    ok &= one_shot_case("select", API_SELECT, CLOCK_MONOTONIC, 0);
    ok &= one_shot_case("read", API_READ, CLOCK_MONOTONIC, 0);
    ok &= one_shot_case("realtime-epoll", API_EPOLL, CLOCK_REALTIME, 0);
    ok &= one_shot_case("abstime-epoll", API_EPOLL, CLOCK_MONOTONIC, 1);
    ok &= periodic_case();
    ok &= armed_while_parked_case();
    ok &= stress_case();
    ok &= eventfd_case("eventfd-thread-epoll", API_EPOLL);
    ok &= eventfd_case("eventfd-thread-poll", API_POLL);
    if (!ok) {
        fprintf(stderr, "FAIL timerfd expiry did not wake its waiter promptly\n");
        return 1;
    }
    printf("TIMERFD_WAKE_PASS\n");
    return 0;
}
