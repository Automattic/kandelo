/*
 * futex-kernel-wait — the futex wait queue is kernel state.
 *
 * Kandelo's kernel owns FUTEX_WAIT: it compares the word, parks the caller,
 * and decides the result when a FUTEX_WAKE, a signal, a cancellation, a
 * thread exit or the deadline ends the wait (crates/runtime-core/src/
 * wait_park.rs). Each case below pins one of those ways out, through the raw
 * syscall so libc's retry loops cannot hide a wrong answer.
 *
 * Output: one "ok <case>" line per case, then "PASS". Any failure prints
 * "FAIL <case>: <detail>" and exits 1.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

#define FUTEX_WAIT 0
#define FUTEX_WAKE 1
#define FUTEX_CMP_REQUEUE 4
#define FUTEX_WAIT_BITSET 9
#define FUTEX_WAKE_BITSET 10

static long futex(atomic_int *addr, int op, int val, const struct timespec *ts,
                  atomic_int *addr2, int val3) {
    return syscall(SYS_futex, addr, op, val, ts, addr2, val3);
}

static long futex_count(atomic_int *addr, int op, int val, long val2,
                        atomic_int *addr2, int val3) {
    return syscall(SYS_futex, addr, op, val, val2, addr2, val3);
}

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

static void sleep_ms(long ms) {
    struct timespec ts = { ms / 1000, (ms % 1000) * 1000000L };
    nanosleep(&ts, NULL);
}

/* -- a waiter thread ------------------------------------------------------ */

struct waiter {
    atomic_int *word;
    int op;
    int bitset;
    const struct timespec *timeout;
    long result;
    int err;
    atomic_int started;
    atomic_int finished;
};

static void *wait_thread(void *arg) {
    struct waiter *w = arg;
    atomic_store(&w->started, 1);
    errno = 0;
    w->result = futex(w->word, w->op, 0, w->timeout, NULL, w->bitset);
    w->err = errno;
    atomic_store(&w->finished, 1);
    return NULL;
}

/* Wait until `w` has entered the kernel. The flag is set just before the
 * syscall, so allow the thread a moment to actually park. */
static void await_parked(struct waiter *w) {
    while (!atomic_load(&w->started)) sleep_ms(1);
    sleep_ms(30);
}

static void start(pthread_t *t, struct waiter *w) {
    if (pthread_create(t, NULL, wait_thread, w) != 0) fail("pthread_create", "failed");
}

static atomic_int handler_hits;
static void on_usr1(int sig) { (void)sig; atomic_fetch_add(&handler_hits, 1); }

static atomic_int cond_ready;
static pthread_mutex_t cond_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cond_var = PTHREAD_COND_INITIALIZER;
/* A real `void (*)(void *)`: calling pthread_mutex_unlock through a cast
 * pointer is a signature mismatch, which Wasm traps on. */
static void unlock_cond_mutex(void *mutex) { pthread_mutex_unlock(mutex); }

static void *cond_thread(void *arg) {
    (void)arg;
    pthread_mutex_lock(&cond_mutex);
    pthread_cleanup_push(unlock_cond_mutex, &cond_mutex);
    atomic_store(&cond_ready, 1);
    for (;;) pthread_cond_wait(&cond_var, &cond_mutex);
    pthread_cleanup_pop(1);
    return NULL;
}

int main(int argc, char **argv) {
    setvbuf(stdout, NULL, _IONBF, 0);
    static atomic_int word, other;
    /* "nosignal" skips the two cases that need a caught signal handler, for a
     * host that does not deliver them (the native host). */
    int with_signals = !(argc > 1 && strcmp(argv[1], "nosignal") == 0);

    /* 1. A mismatched value answers EAGAIN without parking. */
    atomic_store(&word, 7);
    errno = 0;
    if (futex(&word, FUTEX_WAIT, 6, NULL, NULL, 0) != -1 || errno != EAGAIN)
        fail("mismatch", "expected EAGAIN");
    puts("ok mismatch");

    /* 2. A relative timeout ends the wait with ETIMEDOUT, not early. */
    atomic_store(&word, 0);
    struct timespec rel = { 0, 60 * 1000000L };
    long long t0 = now_ms();
    errno = 0;
    if (futex(&word, FUTEX_WAIT, 0, &rel, NULL, 0) != -1 || errno != ETIMEDOUT)
        fail("relative-timeout", "expected ETIMEDOUT");
    if (now_ms() - t0 < 55) fail("relative-timeout", "returned early");
    puts("ok relative-timeout");

    /* 3. FUTEX_WAIT_BITSET's timeout is ABSOLUTE on CLOCK_MONOTONIC. */
    struct timespec abs_deadline;
    clock_gettime(CLOCK_MONOTONIC, &abs_deadline);
    abs_deadline.tv_nsec += 60 * 1000000L;
    if (abs_deadline.tv_nsec >= 1000000000L) {
        abs_deadline.tv_sec += 1;
        abs_deadline.tv_nsec -= 1000000000L;
    }
    t0 = now_ms();
    errno = 0;
    if (futex(&word, FUTEX_WAIT_BITSET, 0, &abs_deadline, NULL, -1) != -1 || errno != ETIMEDOUT)
        fail("absolute-timeout", "expected ETIMEDOUT");
    long long waited = now_ms() - t0;
    if (waited < 55 || waited > 5000) fail("absolute-timeout", "wrong duration");
    puts("ok absolute-timeout");

    /* 4. FUTEX_WAKE ends a parked wait with 0 and reports one woken. */
    pthread_t t;
    struct waiter w = { .word = &word, .op = FUTEX_WAIT };
    start(&t, &w);
    await_parked(&w);
    if (atomic_load(&w.finished)) fail("wake", "waiter did not park");
    long woke = futex_count(&word, FUTEX_WAKE, 1, 0, NULL, 0);
    pthread_join(t, NULL);
    if (woke != 1 || w.result != 0) fail("wake", "expected one waiter woken with 0");
    puts("ok wake");

    /* 5. A bitset wake reaches only waiters whose bitset intersects. */
    struct waiter wb = { .word = &word, .op = FUTEX_WAIT_BITSET, .bitset = 0x2 };
    start(&t, &wb);
    await_parked(&wb);
    if (futex_count(&word, FUTEX_WAKE_BITSET, 1, 0, NULL, 0x1) != 0)
        fail("bitset", "a disjoint bitset woke a waiter");
    if (futex_count(&word, FUTEX_WAKE_BITSET, 1, 0, NULL, 0x2) != 1)
        fail("bitset", "an intersecting bitset did not wake");
    pthread_join(t, NULL);
    puts("ok bitset");

    /* 6. CMP_REQUEUE moves waiters without waking them. */
    pthread_t ta, tb;
    struct waiter wa = { .word = &word, .op = FUTEX_WAIT };
    struct waiter wc = { .word = &word, .op = FUTEX_WAIT };
    start(&ta, &wa);
    start(&tb, &wc);
    await_parked(&wa);
    await_parked(&wc);
    long moved = futex_count(&word, FUTEX_CMP_REQUEUE, 0, 2, &other, 0);
    if (moved != 2) fail("requeue", "expected two requeued");
    sleep_ms(20);
    if (atomic_load(&wa.finished) || atomic_load(&wc.finished))
        fail("requeue", "a requeued waiter woke");
    if (futex_count(&word, FUTEX_WAKE, 2, 0, NULL, 0) != 0)
        fail("requeue", "old word still had waiters");
    if (futex_count(&other, FUTEX_WAKE, 2, 0, NULL, 0) != 2)
        fail("requeue", "new word did not have both waiters");
    pthread_join(ta, NULL);
    pthread_join(tb, NULL);
    puts("ok requeue");

    /* 7. A caught signal directed at the waiter ends the wait with EINTR. */
    if (with_signals) {
        struct sigaction sa;
        memset(&sa, 0, sizeof sa);
        sa.sa_handler = on_usr1;
        sigaction(SIGUSR1, &sa, NULL);
        struct waiter ws = { .word = &word, .op = FUTEX_WAIT };
        start(&t, &ws);
        await_parked(&ws);
        pthread_kill(t, SIGUSR1);
        pthread_join(t, NULL);
        if (ws.result != -1 || ws.err != EINTR || atomic_load(&handler_hits) != 1)
            fail("signal", "expected EINTR after the handler ran");
        puts("ok signal");

        /* 8. A timed wait is not restarted by SA_RESTART (Linux answers EINTR). */
        sa.sa_flags = SA_RESTART;
        sigaction(SIGUSR1, &sa, NULL);
        struct timespec long_rel = { 30, 0 };
        struct waiter wt = { .word = &word, .op = FUTEX_WAIT, .timeout = &long_rel };
        start(&t, &wt);
        await_parked(&wt);
        pthread_kill(t, SIGUSR1);
        pthread_join(t, NULL);
        if (wt.result != -1 || wt.err != EINTR)
            fail("timed-signal", "a timed wait must return EINTR under SA_RESTART");
        puts("ok timed-signal");
    }

    /* 9. pthread_cancel reaches a thread parked in pthread_cond_wait, and
     *    pthread_join (a futex wait on the clear-TID word) returns. */
    if (pthread_create(&t, NULL, cond_thread, NULL) != 0) fail("cancel", "create");
    while (!atomic_load(&cond_ready)) sleep_ms(1);
    sleep_ms(30);
    pthread_cancel(t);
    void *ret = NULL;
    pthread_join(t, &ret);
    if (ret != PTHREAD_CANCELED) fail("cancel", "thread was not cancelled");
    puts("ok cancel");

    puts("PASS");
    return 0;
}
