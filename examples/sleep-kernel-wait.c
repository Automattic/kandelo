/*
 * sleep-kernel-wait — a sleep is a kernel park with a deadline.
 *
 * Kandelo's kernel owns nanosleep, clock_nanosleep and usleep: it reads the
 * request, parks the caller until a CLOCK_MONOTONIC deadline, and decides the
 * result when the deadline passes, a caught signal targets the sleeper, or
 * pthread_cancel reaches it (crates/runtime-core/src/wait_park.rs). On a
 * signal it also stores the unslept time in `rem`, which POSIX requires and
 * the old host-timer implementation never did.
 *
 * Output: one "ok <case>" line per case, then "PASS". Any failure prints
 * "FAIL <case>: <detail>" and exits 1. "nosignal" skips the cases that need a
 * caught signal handler, for a host that does not deliver them (the native
 * host).
 */
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

static void fail(const char *name, const char *detail) {
    printf("FAIL %s: %s (errno=%d)\n", name, detail, errno);
    fflush(stdout);
    exit(1);
}

static long long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static struct timespec ms_ts(long ms) {
    struct timespec ts = { ms / 1000, (ms % 1000) * 1000000L };
    return ts;
}

static struct timespec abs_after(clockid_t clock, long ms) {
    struct timespec ts;
    clock_gettime(clock, &ts);
    ts.tv_sec += ms / 1000;
    ts.tv_nsec += (ms % 1000) * 1000000L;
    if (ts.tv_nsec >= 1000000000L) {
        ts.tv_sec += 1;
        ts.tv_nsec -= 1000000000L;
    }
    return ts;
}

/* -- a sleeper thread ----------------------------------------------------- */

struct sleeper {
    long ms;
    int block_usr1;
    long long elapsed;
    int result;
    int err;
    atomic_int started;
};

static void *sleep_thread(void *arg) {
    struct sleeper *s = arg;
    if (s->block_usr1) {
        sigset_t set;
        sigemptyset(&set);
        sigaddset(&set, SIGUSR1);
        pthread_sigmask(SIG_BLOCK, &set, NULL);
    }
    struct timespec req = ms_ts(s->ms);
    atomic_store(&s->started, 1);
    long long t0 = now_ms();
    errno = 0;
    s->result = nanosleep(&req, NULL);
    s->err = errno;
    s->elapsed = now_ms() - t0;
    return NULL;
}

static void start(pthread_t *t, struct sleeper *s) {
    if (pthread_create(t, NULL, sleep_thread, s) != 0) fail("pthread_create", "failed");
}

/* Wait until `s` has entered the kernel. The flag is set just before the
 * syscall, so allow the thread a moment to actually park. */
static void await_parked(struct sleeper *s) {
    struct timespec one = ms_ts(1), settle = ms_ts(30);
    while (!atomic_load(&s->started)) nanosleep(&one, NULL);
    nanosleep(&settle, NULL);
}

static atomic_int handler_hits;
static void on_usr1(int sig) { (void)sig; atomic_fetch_add(&handler_hits, 1); }

struct kicker {
    pthread_t target;
    long after_ms;
};

static void *kick_thread(void *arg) {
    struct kicker *k = arg;
    struct timespec wait = ms_ts(k->after_ms);
    nanosleep(&wait, NULL);
    pthread_kill(k->target, SIGUSR1);
    return NULL;
}

static void *cancel_target(void *arg) {
    (void)arg;
    struct timespec forever = { 60, 0 };
    for (;;) nanosleep(&forever, NULL);
    return NULL;
}

int main(int argc, char **argv) {
    setvbuf(stdout, NULL, _IONBF, 0);
    int with_signals = !(argc > 1 && strcmp(argv[1], "nosignal") == 0);

    /* 1. A sleep lasts at least its duration, and not wildly longer. */
    struct timespec req = ms_ts(60);
    long long t0 = now_ms();
    if (nanosleep(&req, NULL) != 0) fail("duration", "nanosleep failed");
    long long slept = now_ms() - t0;
    if (slept < 55 || slept > 5000) fail("duration", "wrong duration");
    puts("ok duration");

    /* 2. A zero sleep answers at once. */
    struct timespec zero = { 0, 0 };
    t0 = now_ms();
    if (nanosleep(&zero, NULL) != 0 || now_ms() - t0 > 1000) fail("zero", "zero sleep");
    puts("ok zero");

    /* 3. Invalid and unreadable requests fail without sleeping. */
    struct timespec bad = { 0, 1000000000L };
    errno = 0;
    if (nanosleep(&bad, NULL) != -1 || errno != EINVAL) fail("invalid", "nsec 1e9");
    bad.tv_sec = -1;
    bad.tv_nsec = 0;
    errno = 0;
    if (nanosleep(&bad, NULL) != -1 || errno != EINVAL) fail("invalid", "negative sec");
    errno = 0;
    if (syscall(SYS_nanosleep, NULL, NULL) != -1 || errno != EFAULT)
        fail("invalid", "a null request must be EFAULT");
    puts("ok invalid");

    /* 4. An absolute clock_nanosleep ends at its deadline on either clock,
     *    and one already in the past answers at once. */
    clockid_t clocks[2] = { CLOCK_MONOTONIC, CLOCK_REALTIME };
    for (int i = 0; i < 2; i++) {
        struct timespec deadline = abs_after(clocks[i], 60);
        t0 = now_ms();
        int r = clock_nanosleep(clocks[i], TIMER_ABSTIME, &deadline, NULL);
        slept = now_ms() - t0;
        if (r != 0 || slept < 50 || slept > 5000) fail("absolute", "wrong duration");
        t0 = now_ms();
        if (clock_nanosleep(clocks[i], TIMER_ABSTIME, &deadline, NULL) != 0
            || now_ms() - t0 > 1000)
            fail("absolute", "a past deadline must answer at once");
    }
    if (clock_nanosleep(CLOCK_THREAD_CPUTIME_ID, 0, &req, NULL) != EINVAL)
        fail("absolute", "a CPU-time clock must be EINVAL");
    puts("ok absolute");

    /* 5. usleep sleeps its microseconds. */
    t0 = now_ms();
    if (usleep(40000) != 0) fail("usleep", "usleep failed");
    slept = now_ms() - t0;
    if (slept < 35 || slept > 5000) fail("usleep", "wrong duration");
    puts("ok usleep");

    /* 6. Two threads' sleeps are independent: the short one ends first and
     *    neither is cut short by the other. */
    pthread_t ta, tb;
    struct sleeper longer = { .ms = 150 }, shorter = { .ms = 30 };
    start(&ta, &longer);
    start(&tb, &shorter);
    pthread_join(tb, NULL);
    pthread_join(ta, NULL);
    if (shorter.result != 0 || longer.result != 0) fail("threads", "a sleep failed");
    if (shorter.elapsed < 25 || longer.elapsed < 140) fail("threads", "a sleep ended early");
    puts("ok threads");

    /* 7. pthread_cancel reaches a thread asleep in nanosleep. */
    pthread_t tc;
    if (pthread_create(&tc, NULL, cancel_target, NULL) != 0) fail("cancel", "create");
    struct timespec settle = ms_ts(50);
    nanosleep(&settle, NULL);
    t0 = now_ms();
    pthread_cancel(tc);
    void *ret = NULL;
    pthread_join(tc, &ret);
    if (ret != PTHREAD_CANCELED) fail("cancel", "thread was not cancelled");
    if (now_ms() - t0 > 5000) fail("cancel", "cancellation waited for the sleep");
    puts("ok cancel");

    if (with_signals) {
        /* 8. A caught signal ends a sleep with EINTR even under SA_RESTART,
         *    and `rem` holds the unslept time. */
        struct sigaction sa;
        memset(&sa, 0, sizeof sa);
        sa.sa_handler = on_usr1;
        sa.sa_flags = SA_RESTART;
        sigaction(SIGUSR1, &sa, NULL);
        pthread_t tk;
        struct kicker k = { .target = pthread_self(), .after_ms = 100 };
        pthread_create(&tk, NULL, kick_thread, &k);
        struct timespec two = { 2, 0 }, rem = { -1, -1 };
        errno = 0;
        int r = nanosleep(&two, &rem);
        int err = errno;
        pthread_join(tk, NULL);
        if (r != -1 || err != EINTR) fail("signal-rem", "expected EINTR under SA_RESTART");
        if (atomic_load(&handler_hits) != 1) fail("signal-rem", "handler did not run");
        long long rem_ms = (long long)rem.tv_sec * 1000 + rem.tv_nsec / 1000000;
        if (rem.tv_nsec < 0 || rem.tv_nsec >= 1000000000L || rem_ms < 1000 || rem_ms > 1950)
            fail("signal-rem", "rem does not hold the unslept time");
        puts("ok signal-rem");

        /* 9. sleep(3) interrupted returns the unslept seconds, which only a
         *    written `rem` can tell it. */
        k.after_ms = 100;
        pthread_create(&tk, NULL, kick_thread, &k);
        unsigned left = sleep(3);
        pthread_join(tk, NULL);
        if (left < 2 || left > 3) fail("sleep-left", "sleep() must report the unslept seconds");
        puts("ok sleep-left");

        /* 10. An interrupted absolute sleep answers EINTR and leaves rem
         *     alone (POSIX). */
        pthread_create(&tk, NULL, kick_thread, &k);
        struct timespec deadline = abs_after(CLOCK_MONOTONIC, 2000);
        struct timespec untouched = { 77, 77 };
        r = clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &deadline, &untouched);
        pthread_join(tk, NULL);
        if (r != EINTR) fail("signal-absolute", "expected EINTR");
        if (untouched.tv_sec != 77 || untouched.tv_nsec != 77)
            fail("signal-absolute", "rem was written for an absolute sleep");
        puts("ok signal-absolute");

        /* 11. A signal the sleeper blocks does not end its sleep; a signal
         *     for another thread does not end it either. */
        pthread_t tbk;
        struct sleeper blocked = { .ms = 150, .block_usr1 = 1 };
        start(&tbk, &blocked);
        await_parked(&blocked);
        pthread_kill(tbk, SIGUSR1);
        pthread_join(tbk, NULL);
        if (blocked.result != 0 || blocked.elapsed < 140)
            fail("blocked-signal", "a blocked signal ended the sleep");
        puts("ok blocked-signal");
    }

    puts("PASS");
    return 0;
}
