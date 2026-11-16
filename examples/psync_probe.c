/*
 * psync-probe: observe POSIX process-shared synchronization on Kandelo.
 *
 * Each case prints one line:
 *   case <name>: expect <posix>; observed <what happened>; <OK|DIVERGES>
 * No case blocks without a bound, so a lost wakeup shows up as a timeout
 * rather than a hang.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <sched.h>
#include <semaphore.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static double now_s(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

static struct timespec abs_after(clockid_t clk, double secs) {
    struct timespec ts;
    clock_gettime(clk, &ts);
    long long ns = ts.tv_nsec + (long long)(secs * 1e9);
    ts.tv_sec += ns / 1000000000LL;
    ts.tv_nsec = ns % 1000000000LL;
    return ts;
}

static void *shared_page(size_t len) {
    void *p = mmap(NULL, len, PROT_READ | PROT_WRITE,
                   MAP_SHARED | MAP_ANONYMOUS, -1, 0);
    if (p == MAP_FAILED) {
        perror("mmap");
        exit(2);
    }
    memset(p, 0, len);
    return p;
}

static void report(const char *name, const char *expect, int ok,
                   const char *fmt, ...) {
    char buf[256];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    printf("case %s: expect %s; observed %s; %s\n", name, expect, buf,
           ok ? "OK" : "DIVERGES");
    fflush(stdout);
}

static int reap(pid_t pid) {
    int status = 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
    return status;
}

/* A: unnamed pshared semaphore, child posts while parent waits. */
static void case_sem_unnamed_wakeup(void) {
    sem_t *s = shared_page(4096);
    if (sem_init(s, 1, 0) != 0) { perror("sem_init"); return; }
    pid_t pid = fork();
    if (pid == 0) {
        usleep(200000);
        sem_post(s);
        _exit(0);
    }
    double t0 = now_s();
    struct timespec at = abs_after(CLOCK_REALTIME, 3.0);
    int r = sem_timedwait(s, &at);
    int e = r ? errno : 0;
    double dt = now_s() - t0;
    reap(pid);
    int v = -1;
    sem_getvalue(s, &v);
    report("sem-init-pshared-wakeup", "sem_timedwait returns 0 after ~0.2 s",
           r == 0 && dt < 1.5,
           "r=%d errno=%s after %.2f s; sem_getvalue afterwards=%d", r,
           e ? strerror(e) : "0", dt, v);
}

/* B: named semaphore, child posts while parent waits. */
static void case_sem_named_wakeup(void) {
    const char *name = "/psync-probe";
    sem_unlink(name);
    sem_t *s = sem_open(name, O_CREAT | O_EXCL, 0600, 0);
    if (s == SEM_FAILED) { perror("sem_open"); return; }
    sem_unlink(name);
    pid_t pid = fork();
    if (pid == 0) {
        usleep(200000);
        sem_post(s);
        _exit(0);
    }
    double t0 = now_s();
    struct timespec at = abs_after(CLOCK_REALTIME, 3.0);
    int r = sem_timedwait(s, &at);
    int e = r ? errno : 0;
    double dt = now_s() - t0;
    reap(pid);
    int v = -1;
    sem_getvalue(s, &v);
    report("sem-open-wakeup", "sem_timedwait returns 0 after ~0.2 s",
           r == 0 && dt < 1.5,
           "r=%d errno=%s after %.2f s; sem_getvalue afterwards=%d", r,
           e ? strerror(e) : "0", dt, v);
    sem_close(s);
}

/* C: a pshared semaphore with value 1 must admit exactly one process. */
static void case_sem_binary_admits_one(void) {
    sem_t *s = shared_page(4096);
    sem_init(s, 1, 1);
    pid_t pid = fork();
    if (pid == 0) {
        /* Delay without entering the kernel, so this process does not
         * import the parent's store before its own atomic. */
        for (volatile long i = 0; i < 300000000L; i++) {}
        int r = sem_trywait(s);
        _exit(r == 0 ? 0 : 1);
    }
    int r = sem_trywait(s);
    usleep(1000);
    int st = reap(pid);
    int child_ok = WIFEXITED(st) && WEXITSTATUS(st) == 0;
    int admitted = (r == 0) + child_ok;
    int v = -1;
    sem_getvalue(s, &v);
    report("sem-binary-admits-one", "exactly one of two sem_trywait succeeds",
           admitted == 1,
           "%d of 2 succeeded (parent r=%d, child %s); value afterwards=%d",
           admitted, r, child_ok ? "succeeded" : "EAGAIN", v);
}

/* D: a pshared mutex must still exclude threads of one process. */
struct dctx {
    pthread_mutex_t *m;
    int result;
};
static void *d_thread(void *arg) {
    struct dctx *c = arg;
    c->result = pthread_mutex_trylock(c->m);
    return NULL;
}
static void case_mutex_threads(void) {
    pthread_mutex_t *m = shared_page(4096);
    pthread_mutexattr_t a;
    pthread_mutexattr_init(&a);
    pthread_mutexattr_setpshared(&a, PTHREAD_PROCESS_SHARED);
    pthread_mutexattr_settype(&a, PTHREAD_MUTEX_RECURSIVE);
    pthread_mutex_init(m, &a);
    pthread_mutex_lock(m);
    struct dctx c = { m, -1 };
    pthread_t t;
    pthread_create(&t, NULL, d_thread, &c);
    pthread_join(t, NULL);
    report("pshared-recursive-mutex-other-thread",
           "trylock from a second thread returns EBUSY", c.result == EBUSY,
           "trylock returned %s", c.result ? strerror(c.result) : "0 (acquired)");
    pthread_mutex_unlock(m);
}

/* E: a non-robust pshared mutex whose owner exits stays locked. */
static void case_mutex_owner_exit(void) {
    pthread_mutex_t *m = shared_page(4096);
    pthread_mutexattr_t a;
    pthread_mutexattr_init(&a);
    pthread_mutexattr_setpshared(&a, PTHREAD_PROCESS_SHARED);
    pthread_mutex_init(m, &a);
    pid_t pid = fork();
    if (pid == 0) {
        pthread_mutex_lock(m);
        _exit(0);
    }
    reap(pid);
    int r = pthread_mutex_trylock(m);
    report("pshared-mutex-owner-exit",
           "PTHREAD_MUTEX_STALLED: trylock returns EBUSY", r == EBUSY,
           "trylock returned %s", r ? strerror(r) : "0 (acquired)");
    if (r == 0) pthread_mutex_unlock(m);
}

/* F: a robust pshared mutex whose owner exits reports EOWNERDEAD. */
static void case_robust_owner_exit(void) {
    pthread_mutex_t *m = shared_page(4096);
    pthread_mutexattr_t a;
    pthread_mutexattr_init(&a);
    pthread_mutexattr_setpshared(&a, PTHREAD_PROCESS_SHARED);
    pthread_mutexattr_setrobust(&a, PTHREAD_MUTEX_ROBUST);
    pthread_mutex_init(m, &a);
    pid_t pid = fork();
    if (pid == 0) {
        pthread_mutex_lock(m);
        _exit(0);
    }
    reap(pid);
    int r = pthread_mutex_trylock(m);
    report("robust-pshared-owner-exit", "trylock returns EOWNERDEAD",
           r == EOWNERDEAD, "trylock returned %s",
           r ? strerror(r) : "0 (acquired)");
}

/* G: pthread_cond_timedwait on a pshared cond, signalled by another process. */
struct gshared {
    pthread_mutex_t m;
    pthread_cond_t c;
    volatile int flag;
};
static void case_cond_timedwait(void) {
    struct gshared *g = shared_page(4096);
    pthread_mutexattr_t ma;
    pthread_mutexattr_init(&ma);
    pthread_mutexattr_setpshared(&ma, PTHREAD_PROCESS_SHARED);
    pthread_mutex_init(&g->m, &ma);
    pthread_condattr_t ca;
    pthread_condattr_init(&ca);
    pthread_condattr_setpshared(&ca, PTHREAD_PROCESS_SHARED);
    pthread_cond_init(&g->c, &ca);
    pid_t pid = fork();
    if (pid == 0) {
        usleep(200000);
        pthread_mutex_lock(&g->m);
        g->flag = 1;
        pthread_cond_signal(&g->c);
        pthread_mutex_unlock(&g->m);
        _exit(0);
    }
    double t0 = now_s();
    pthread_mutex_lock(&g->m);
    int r = 0;
    while (!g->flag && r == 0) {
        struct timespec at = abs_after(CLOCK_REALTIME, 3.0);
        r = pthread_cond_timedwait(&g->c, &g->m, &at);
    }
    pthread_mutex_unlock(&g->m);
    double dt = now_s() - t0;
    reap(pid);
    report("pshared-cond-timedwait", "returns 0 after ~0.2 s",
           r == 0 && dt < 1.5, "r=%s after %.2f s (flag=%d)",
           r ? strerror(r) : "0", dt, g->flag);
}

/* H: kernel pshared mutex handoff latency (lock blocks in another process). */
struct hshared {
    pthread_mutex_t m;
    volatile double acquired;
};
static void case_mutex_handoff(void) {
    struct hshared *h = shared_page(4096);
    pthread_mutexattr_t a;
    pthread_mutexattr_init(&a);
    pthread_mutexattr_setpshared(&a, PTHREAD_PROCESS_SHARED);
    pthread_mutex_init(&h->m, &a);
    pthread_mutex_lock(&h->m);
    pid_t pid = fork();
    if (pid == 0) {
        pthread_mutex_lock(&h->m);
        h->acquired = now_s();
        pthread_mutex_unlock(&h->m);
        _exit(0);
    }
    usleep(200000);
    double released = now_s();
    pthread_mutex_unlock(&h->m);
    reap(pid);
    usleep(1000); /* import the child's published store */
    double lat = h->acquired - released;
    report("pshared-mutex-handoff", "the blocked process acquires promptly",
           lat >= 0 && lat < 0.05, "acquired %.2f ms after unlock", lat * 1e3);
}

/* I: pshared rwlock reader blocked in another process. */
static void case_rwlock_wakeup(void) {
    pthread_rwlock_t *rw = shared_page(4096);
    pthread_rwlockattr_t a;
    pthread_rwlockattr_init(&a);
    pthread_rwlockattr_setpshared(&a, PTHREAD_PROCESS_SHARED);
    pthread_rwlock_init(rw, &a);
    pthread_rwlock_wrlock(rw);
    pid_t pid = fork();
    if (pid == 0) {
        double t0 = now_s();
        struct timespec at = abs_after(CLOCK_REALTIME, 3.0);
        int r = pthread_rwlock_timedrdlock(rw, &at);
        double dt = now_s() - t0;
        report("pshared-rwlock-wakeup",
               "timedrdlock returns 0 after ~0.2 s", r == 0 && dt < 1.5,
               "r=%s after %.2f s", r ? strerror(r) : "0", dt);
        _exit(0);
    }
    usleep(200000);
    pthread_rwlock_unlock(rw);
    reap(pid);
}

/* J: a pshared semaphore used as a lock around a shared counter. */
struct jshared {
    sem_t s;
    volatile int counter;
};
static void case_sem_counter(void) {
    enum { KIDS = 3, ITERS = 200 };
    struct jshared *j = shared_page(4096);
    sem_init(&j->s, 1, 1);
    pid_t kids[KIDS];
    int gate[2];
    pipe(gate);
    double t0 = now_s();
    for (int k = 0; k < KIDS; k++) {
        kids[k] = fork();
        if (kids[k] == 0) {
            char b;
            close(gate[1]);
            read(gate[0], &b, 1); /* start together */
            int timeouts = 0;
            for (int i = 0; i < ITERS; i++) {
                struct timespec at = abs_after(CLOCK_REALTIME, 0.5);
                if (sem_timedwait(&j->s, &at) != 0) timeouts++;
                int c = j->counter;
                sched_yield(); /* let peers run inside the critical section */
                j->counter = c + 1;
                sem_post(&j->s);
                sched_yield();
            }
            _exit(timeouts > 255 ? 255 : timeouts);
        }
    }
    close(gate[0]);
    write(gate[1], "xxx", KIDS);
    close(gate[1]);
    int timeouts = 0;
    for (int k = 0; k < KIDS; k++) {
        int st = reap(kids[k]);
        if (WIFEXITED(st)) timeouts += WEXITSTATUS(st);
    }
    usleep(1000);
    double dt = now_s() - t0;
    report("sem-lock-counter", "counter 600, no timed-out acquisitions",
           j->counter == KIDS * ITERS && timeouts == 0,
           "counter=%d, timed-out acquisitions=%d, %.2f s", j->counter,
           timeouts, dt);
}

/* K: uncontended cost per operation pair (no process contention). */
static void case_cost(void) {
    enum { N = 5000 };
    sem_t *ps = shared_page(4096);
    sem_t priv;
    sem_init(ps, 1, 1);
    sem_init(&priv, 0, 1);
    double t0 = now_s();
    for (int i = 0; i < N; i++) { sem_trywait(&priv); sem_post(&priv); }
    double t1 = now_s();
    for (int i = 0; i < N; i++) { sem_trywait(ps); sem_post(ps); }
    double t2 = now_s();
    pthread_mutex_t *pm = shared_page(4096);
    pthread_mutexattr_t a;
    pthread_mutexattr_init(&a);
    pthread_mutexattr_setpshared(&a, PTHREAD_PROCESS_SHARED);
    pthread_mutex_init(pm, &a);
    double t3 = now_s();
    for (int i = 0; i < N; i++) { pthread_mutex_lock(pm); pthread_mutex_unlock(pm); }
    double t4 = now_s();
    for (int i = 0; i < N; i++) getppid();
    double t5 = now_s();
    printf("cost: private sem trywait+post %.2f us; pshared sem trywait+post %.2f us; "
           "pshared mutex lock+unlock %.2f us; getppid %.2f us\n",
           (t1 - t0) / N * 1e6, (t2 - t1) / N * 1e6, (t4 - t3) / N * 1e6,
           (t5 - t4) / N * 1e6);
    fflush(stdout);
}

int main(int argc, char **argv) {
    printf("psync-probe pid=%d\n", (int)getpid());
    fflush(stdout);
    const char *only = argc > 1 ? argv[1] : NULL;
#define RUN(tag, fn) if (!only || !strcmp(only, tag)) fn()
    RUN("A", case_sem_unnamed_wakeup);
    RUN("B", case_sem_named_wakeup);
    RUN("C", case_sem_binary_admits_one);
    RUN("D", case_mutex_threads);
    RUN("E", case_mutex_owner_exit);
    RUN("F", case_robust_owner_exit);
    RUN("G", case_cond_timedwait);
    RUN("H", case_mutex_handoff);
    RUN("I", case_rwlock_wakeup);
    RUN("J", case_sem_counter);
    RUN("K", case_cost);
    printf("done\n");
    return 0;
}
