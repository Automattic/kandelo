/*
 * signal-kernel-wait — sigsuspend, pause and sigtimedwait are kernel parks.
 *
 * Kandelo's kernel owns all three waits (crates/runtime-core/src/
 * wait_signal.rs): it parks the caller and decides the result when a signal
 * arrives, the timeout passes, or pthread_cancel reaches it. Before, the host
 * re-ran sigsuspend/pause every 10 ms and an untimed sigtimedwait every
 * 500 ms; these cases pin the decisions that replaced those polls.
 *
 * Output: one "ok <case>" line per case, then "PASS". Any failure prints
 * "FAIL <case>: <detail>" and exits 1.
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
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static void fail(const char *name, const char *detail) {
    printf("FAIL %s: %s (errno=%d)\n", name, detail, errno);
    fflush(stdout);
    exit(1);
}

static void ok(const char *name) {
    printf("ok %s\n", name);
    fflush(stdout);
}

static long long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static volatile sig_atomic_t usr1_handled;
static volatile sig_atomic_t usr2_handled;

static void on_usr1(int sig) { (void)sig; usr1_handled++; }
static void on_usr2(int sig) { (void)sig; usr2_handled++; }

static void install(int sig, void (*handler)(int)) {
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = handler;
    sigemptyset(&sa.sa_mask);
    if (sigaction(sig, &sa, NULL) != 0)
        fail("setup", "sigaction");
}

static void block_only(int sig) {
    sigset_t set;
    sigemptyset(&set);
    if (sig)
        sigaddset(&set, sig);
    if (pthread_sigmask(SIG_SETMASK, &set, NULL) != 0)
        fail("setup", "pthread_sigmask");
}

/* -- a thread that signals the main thread after a delay ------------------ */

struct poke {
    pthread_t target;
    int sig;
    int delay_ms;
};

static void *poke_thread(void *arg) {
    struct poke *p = arg;
    /* The poker must not take the signal itself. */
    sigset_t all;
    sigfillset(&all);
    pthread_sigmask(SIG_BLOCK, &all, NULL);
    usleep((useconds_t)p->delay_ms * 1000);
    pthread_kill(p->target, p->sig);
    return NULL;
}

static pthread_t poke_later(int sig, int delay_ms, struct poke *p) {
    pthread_t thread;
    p->target = pthread_self();
    p->sig = sig;
    p->delay_ms = delay_ms;
    if (pthread_create(&thread, NULL, poke_thread, p) != 0)
        fail("setup", "pthread_create");
    return thread;
}

/* -- sigsuspend / pause ---------------------------------------------------- */

static void case_sigsuspend(void) {
    install(SIGUSR1, on_usr1);
    block_only(SIGUSR1);
    usr1_handled = 0;
    struct poke p;
    pthread_t poker = poke_later(SIGUSR1, 50, &p);
    sigset_t wait_mask;
    sigemptyset(&wait_mask);
    errno = 0;
    int rc = sigsuspend(&wait_mask);
    if (rc != -1 || errno != EINTR)
        fail("sigsuspend", "did not return EINTR");
    if (usr1_handled != 1)
        fail("sigsuspend", "handler did not run once");
    sigset_t after;
    pthread_sigmask(SIG_SETMASK, NULL, &after);
    if (!sigismember(&after, SIGUSR1))
        fail("sigsuspend", "the original mask was not restored");
    pthread_join(poker, NULL);
    block_only(0);
    ok("sigsuspend");
}

static void case_pause_from_child(void) {
    install(SIGUSR2, on_usr2);
    usr2_handled = 0;
    pid_t parent = getpid();
    pid_t child = fork();
    if (child < 0)
        fail("pause-child", "fork");
    if (child == 0) {
        usleep(50000);
        kill(parent, SIGUSR2);
        _exit(0);
    }
    errno = 0;
    while (usr2_handled == 0) {
        if (pause() != -1 || errno != EINTR)
            fail("pause-child", "pause did not return EINTR");
    }
    int status;
    if (waitpid(child, &status, 0) != child)
        fail("pause-child", "waitpid");
    ok("pause-child");
}

static void case_suspend_ignores_blocked(void) {
    /* A signal the temporary mask blocks must not end the wait. */
    install(SIGUSR1, on_usr1);
    install(SIGUSR2, on_usr2);
    block_only(SIGUSR1);
    usr1_handled = 0;
    usr2_handled = 0;
    struct poke first, second;
    pthread_t p1 = poke_later(SIGUSR1, 30, &first);  /* blocked: stays pending */
    pthread_t p2 = poke_later(SIGUSR2, 120, &second); /* ends the wait */
    sigset_t wait_mask;
    sigemptyset(&wait_mask);
    sigaddset(&wait_mask, SIGUSR1);
    long long t0 = now_ms();
    errno = 0;
    if (sigsuspend(&wait_mask) != -1 || errno != EINTR)
        fail("suspend-blocked", "did not return EINTR");
    long long elapsed = now_ms() - t0;
    if (usr2_handled != 1 || usr1_handled != 0)
        fail("suspend-blocked", "the blocked signal ended the wait");
    if (elapsed < 80)
        fail("suspend-blocked", "returned before the unblocked signal");
    pthread_join(p1, NULL);
    pthread_join(p2, NULL);
    block_only(0); /* delivers the pending SIGUSR1 */
    if (usr1_handled != 1)
        fail("suspend-blocked", "the blocked signal was lost");
    ok("suspend-blocked");
}

/* -- sigtimedwait ---------------------------------------------------------- */

static void case_sigtimedwait_pending(void) {
    block_only(SIGUSR1);
    raise(SIGUSR1);
    sigset_t set;
    sigemptyset(&set);
    sigaddset(&set, SIGUSR1);
    siginfo_t info;
    memset(&info, 0, sizeof(info));
    struct timespec zero = {0, 0};
    int sig = sigtimedwait(&set, &info, &zero);
    if (sig != SIGUSR1 || info.si_signo != SIGUSR1)
        fail("timedwait-pending", "did not take the pending signal");
    block_only(0);
    ok("timedwait-pending");
}

static void case_sigtimedwait_wakes(void) {
    block_only(SIGUSR2);
    struct poke p;
    pthread_t poker = poke_later(SIGUSR2, 50, &p);
    sigset_t set;
    sigemptyset(&set);
    sigaddset(&set, SIGUSR2);
    siginfo_t info;
    memset(&info, 0, sizeof(info));
    long long t0 = now_ms();
    /* No timeout: the old host re-ran this every 500 ms. */
    int sig = sigtimedwait(&set, &info, NULL);
    long long elapsed = now_ms() - t0;
    if (sig != SIGUSR2 || info.si_signo != SIGUSR2 || info.si_pid != getpid())
        fail("timedwait-wakes", "wrong signal or siginfo");
    if (elapsed > 400)
        fail("timedwait-wakes", "the wake waited for a poll");
    pthread_join(poker, NULL);
    sigset_t pending;
    sigpending(&pending);
    if (sigismember(&pending, SIGUSR2))
        fail("timedwait-wakes", "the taken signal is still pending");
    block_only(0);
    ok("timedwait-wakes");
}

static void case_sigtimedwait_timeout(void) {
    block_only(SIGUSR1);
    sigset_t set;
    sigemptyset(&set);
    sigaddset(&set, SIGUSR1);
    struct timespec ts = {0, 100 * 1000000L};
    long long t0 = now_ms();
    errno = 0;
    int sig = sigtimedwait(&set, NULL, &ts);
    long long elapsed = now_ms() - t0;
    if (sig != -1 || errno != EAGAIN)
        fail("timedwait-timeout", "did not time out with EAGAIN");
    if (elapsed < 90)
        fail("timedwait-timeout", "returned before the timeout");
    struct timespec zero = {0, 0};
    errno = 0;
    if (sigtimedwait(&set, NULL, &zero) != -1 || errno != EAGAIN)
        fail("timedwait-timeout", "a zero timeout did not poll");
    block_only(0);
    ok("timedwait-timeout");
}

static void case_sigtimedwait_interrupted(void) {
    /* A caught, unblocked signal outside the set interrupts the wait: the
     * kernel answers EINTR, never restarted, SA_RESTART or not. musl's
     * sigtimedwait() then re-issues the call (as it does on Linux), so the
     * raw syscall is what shows the kernel's answer. The 64-bit seconds and
     * nanoseconds pair is the time64 layout musl itself passes. */
    install(SIGUSR2, on_usr2);
    block_only(SIGUSR1);
    usr2_handled = 0;
    struct poke p;
    pthread_t poker = poke_later(SIGUSR2, 50, &p);
    sigset_t set;
    sigemptyset(&set);
    sigaddset(&set, SIGUSR1);
    long long ts[2] = {5, 0};
    errno = 0;
    long rc = syscall(SYS_rt_sigtimedwait, &set, NULL, ts, 8);
    if (rc != -1 || errno != EINTR || usr2_handled != 1)
        fail("timedwait-eintr", "the kernel did not interrupt the wait for the handler");
    pthread_join(poker, NULL);

    /* Through libc the handler runs and the wait goes on to its timeout. */
    usr2_handled = 0;
    poker = poke_later(SIGUSR2, 50, &p);
    struct timespec short_ts = {0, 300 * 1000000L};
    long long t0 = now_ms();
    errno = 0;
    int sig = sigtimedwait(&set, NULL, &short_ts);
    long long elapsed = now_ms() - t0;
    if (sig != -1 || errno != EAGAIN || usr2_handled != 1 || elapsed < 300)
        fail("timedwait-eintr", "libc sigtimedwait did not run the handler and keep waiting");
    pthread_join(poker, NULL);
    block_only(0);
    ok("timedwait-eintr");
}

/* Two threads wait for the same process-directed signal: each kill() ends
 * exactly one wait. */
struct waiter {
    atomic_int started;
    atomic_int done;
    int sig;
};

static void *timedwait_thread(void *arg) {
    struct waiter *w = arg;
    sigset_t set;
    sigemptyset(&set);
    sigaddset(&set, SIGUSR1);
    atomic_store(&w->started, 1);
    w->sig = sigtimedwait(&set, NULL, NULL);
    atomic_store(&w->done, 1);
    return NULL;
}

static void case_sigtimedwait_shared(void) {
    block_only(SIGUSR1);
    struct waiter w[2];
    pthread_t threads[2];
    for (int i = 0; i < 2; i++) {
        memset(&w[i], 0, sizeof(w[i]));
        if (pthread_create(&threads[i], NULL, timedwait_thread, &w[i]) != 0)
            fail("timedwait-shared", "pthread_create");
        while (!atomic_load(&w[i].started))
            usleep(1000);
    }
    usleep(50000);
    kill(getpid(), SIGUSR1);
    long long t0 = now_ms();
    while (atomic_load(&w[0].done) + atomic_load(&w[1].done) < 1) {
        if (now_ms() - t0 > 2000)
            fail("timedwait-shared", "no waiter took the first signal");
        usleep(1000);
    }
    usleep(50000);
    if (atomic_load(&w[0].done) + atomic_load(&w[1].done) != 1)
        fail("timedwait-shared", "one signal ended both waits");
    kill(getpid(), SIGUSR1);
    for (int i = 0; i < 2; i++)
        pthread_join(threads[i], NULL);
    if (w[0].sig != SIGUSR1 || w[1].sig != SIGUSR1)
        fail("timedwait-shared", "a waiter returned something else");
    block_only(0);
    ok("timedwait-shared");
}

/* -- cancellation ---------------------------------------------------------- */

static atomic_int cleanup_ran;
static void on_cleanup(void *arg) { (void)arg; atomic_store(&cleanup_ran, 1); }

static void *suspend_thread(void *arg) {
    atomic_int *started = arg;
    pthread_cleanup_push(on_cleanup, NULL);
    /* Block every ordinary signal while suspended: only pthread_cancel can
     * end this wait. */
    sigset_t all;
    sigfillset(&all);
    atomic_store(started, 1);
    sigsuspend(&all);
    pthread_cleanup_pop(0);
    return NULL;
}

static void case_cancel(void) {
    atomic_int started = 0;
    atomic_store(&cleanup_ran, 0);
    pthread_t thread;
    if (pthread_create(&thread, NULL, suspend_thread, &started) != 0)
        fail("cancel", "pthread_create");
    while (!atomic_load(&started))
        usleep(1000);
    usleep(50000);
    pthread_cancel(thread);
    void *result;
    pthread_join(thread, &result);
    if (result != PTHREAD_CANCELED || !atomic_load(&cleanup_ran))
        fail("cancel", "sigsuspend was not a cancellation point");
    ok("cancel");
}

int main(void) {
    case_sigsuspend();
    case_pause_from_child();
    case_suspend_ignores_blocked();
    case_sigtimedwait_pending();
    case_sigtimedwait_wakes();
    case_sigtimedwait_timeout();
    case_sigtimedwait_interrupted();
    case_sigtimedwait_shared();
    case_cancel();
    puts("PASS");
    return 0;
}
