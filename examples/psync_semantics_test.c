/*
 * psync_semantics_test — POSIX process-shared synchronization, case by case.
 *
 * Each case checks one POSIX requirement for an object placed in shared
 * memory with PTHREAD_PROCESS_SHARED or sem_init(pshared=1), or opened with
 * sem_open(). Every case runs in its own forked child under a deadline, so a
 * lost wakeup or a deadlock is reported, not hung on. Output, one line per
 * case:
 *
 *   case <name>: PASS <detail>
 *   case <name>: DIVERGE <detail>
 *
 * then PSYNC_SEMANTICS_DONE. The program exits 0 when every case reported.
 * Which cases Kandelo is expected to pass today is recorded beside the host
 * tests (host/test/fixtures/psync-semantics.ts), and the plan that fixes the
 * rest is docs/plans/2026-11-15-process-shared-synchronization-design.md.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <sched.h>
#include <semaphore.h>
#include <signal.h>
#include <stdarg.h>
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

static struct timespec realtime_after(double secs) {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    long long ns = ts.tv_nsec + (long long)(secs * 1e9);
    ts.tv_sec += ns / 1000000000LL;
    ts.tv_nsec = ns % 1000000000LL;
    return ts;
}

static void *shared_page(void) {
    void *p = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS,
                   -1, 0);
    if (p == MAP_FAILED) {
        printf("setup: mmap failed: %s\n", strerror(errno));
        fflush(stdout);
        _exit(2);
    }
    memset(p, 0, 4096);
    return p;
}

static const char *current_case;

static void report(int pass, const char *fmt, ...) {
    char detail[256];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(detail, sizeof detail, fmt, ap);
    va_end(ap);
    printf("case %s: %s %s\n", current_case, pass ? "PASS" : "DIVERGE", detail);
    fflush(stdout);
}

static const char *err_name(int e) {
    switch (e) {
    case 0: return "0";
    case EBUSY: return "EBUSY";
    case EPERM: return "EPERM";
    case EINVAL: return "EINVAL";
    case EAGAIN: return "EAGAIN";
    case ETIMEDOUT: return "ETIMEDOUT";
    case EOWNERDEAD: return "EOWNERDEAD";
    case EDEADLK: return "EDEADLK";
    default: return strerror(e);
    }
}

static int reap(pid_t pid) {
    int status = 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
    return status;
}

static void init_mutex(pthread_mutex_t *m, int type, int robust) {
    pthread_mutexattr_t a;
    pthread_mutexattr_init(&a);
    pthread_mutexattr_setpshared(&a, PTHREAD_PROCESS_SHARED);
    pthread_mutexattr_settype(&a, type);
    if (robust) pthread_mutexattr_setrobust(&a, PTHREAD_MUTEX_ROBUST);
    pthread_mutex_init(m, &a);
    pthread_mutexattr_destroy(&a);
}

static void init_cond(pthread_cond_t *c) {
    pthread_condattr_t a;
    pthread_condattr_init(&a);
    pthread_condattr_setpshared(&a, PTHREAD_PROCESS_SHARED);
    pthread_cond_init(c, &a);
    pthread_condattr_destroy(&a);
}

/* ── Semaphores ─────────────────────────────────────────────────────── */

/* A post in one process wakes a sem_timedwait in another. */
static void sem_pshared_wakeup(void) {
    sem_t *s = shared_page();
    sem_init(s, 1, 0);
    pid_t pid = fork();
    if (pid == 0) {
        usleep(200000);
        sem_post(s);
        _exit(0);
    }
    double t0 = now_s();
    struct timespec at = realtime_after(3.0);
    int r = sem_timedwait(s, &at) ? errno : 0;
    double dt = now_s() - t0;
    reap(pid);
    report(r == 0 && dt < 2.0, "sem_timedwait=%s after %.2f s", err_name(r), dt);
}

static void sem_open_wakeup(void) {
    const char *name = "/psync-semantics-test";
    sem_unlink(name);
    sem_t *s = sem_open(name, O_CREAT | O_EXCL, 0600, 0);
    if (s == SEM_FAILED) {
        report(0, "sem_open failed: %s", strerror(errno));
        return;
    }
    sem_unlink(name);
    pid_t pid = fork();
    if (pid == 0) {
        usleep(200000);
        sem_post(s);
        _exit(0);
    }
    double t0 = now_s();
    struct timespec at = realtime_after(3.0);
    int r = sem_timedwait(s, &at) ? errno : 0;
    double dt = now_s() - t0;
    reap(pid);
    report(r == 0 && dt < 2.0, "sem_timedwait=%s after %.2f s", err_name(r), dt);
}

/*
 * A semaphore with value 1 admits one of two processes. The parent takes it
 * and then makes no syscall for a while, so the child, which also makes no
 * syscall before sem_trywait, works on its own copy of the shared page. On a
 * platform where shared memory is one memory the child sees 0.
 */
static void sem_binary_one_holder(void) {
    sem_t *s = shared_page();
    sem_init(s, 1, 1);
    pid_t pid = fork();
    if (pid == 0) _exit(sem_trywait(s) == 0 ? 0 : 1);
    int parent = sem_trywait(s) == 0;
    for (volatile long i = 0; i < 400000000L; i++) {}
    int st = reap(pid);
    int child = WIFEXITED(st) && WEXITSTATUS(st) == 0;
    report(parent + child == 1, "%d of 2 processes took the semaphore", parent + child);
}

/* Three processes increment a counter under a process-shared semaphore. */
struct counter { sem_t s; pthread_mutex_t m; volatile int n; };

static void sem_lock_counter(void) {
    struct counter *c = shared_page();
    sem_init(&c->s, 1, 1);
    int gate[2];
    pipe(gate);
    pid_t kids[3];
    for (int k = 0; k < 3; k++) {
        if ((kids[k] = fork()) == 0) {
            char b;
            close(gate[1]);
            read(gate[0], &b, 1);
            int timeouts = 0;
            for (int i = 0; i < 100; i++) {
                struct timespec at = realtime_after(0.5);
                if (sem_timedwait(&c->s, &at) != 0) timeouts++;
                int v = c->n;
                sched_yield();
                c->n = v + 1;
                sem_post(&c->s);
                sched_yield();
            }
            _exit(timeouts > 100 ? 100 : timeouts);
        }
    }
    close(gate[0]);
    write(gate[1], "xxx", 3);
    close(gate[1]);
    int timeouts = 0;
    for (int k = 0; k < 3; k++) {
        int st = reap(kids[k]);
        timeouts += WIFEXITED(st) ? WEXITSTATUS(st) : 100;
    }
    usleep(1000);
    report(c->n == 300 && timeouts == 0, "counter=%d of 300, timed-out waits=%d",
           c->n, timeouts);
}

/* ── Mutexes ────────────────────────────────────────────────────────── */

struct thread_try { pthread_mutex_t *m; int result; int op; };

static void *other_thread(void *arg) {
    struct thread_try *t = arg;
    t->result = t->op == 0 ? pthread_mutex_trylock(t->m) : pthread_mutex_unlock(t->m);
    return NULL;
}

/* A process-shared mutex still excludes the threads of one process. */
static void mutex_thread_exclusion(void) {
    pthread_mutex_t *m = shared_page();
    init_mutex(m, PTHREAD_MUTEX_RECURSIVE, 0);
    pthread_mutex_lock(m);
    struct thread_try t = { m, -1, 0 };
    pthread_t th;
    pthread_create(&th, NULL, other_thread, &t);
    pthread_join(th, NULL);
    report(t.result == EBUSY, "second thread trylock=%s", err_name(t.result));
}

/* An error-checking mutex refuses an unlock by a thread that does not own it. */
static void mutex_errorcheck_foreign_unlock(void) {
    pthread_mutex_t *m = shared_page();
    init_mutex(m, PTHREAD_MUTEX_ERRORCHECK, 0);
    pthread_mutex_lock(m);
    struct thread_try t = { m, -1, 1 };
    pthread_t th;
    pthread_create(&th, NULL, other_thread, &t);
    pthread_join(th, NULL);
    report(t.result == EPERM, "unlock by second thread=%s", err_name(t.result));
}

/* PTHREAD_MUTEX_STALLED: a mutex whose owner process exits stays locked. */
static void mutex_owner_exit_stalled(void) {
    pthread_mutex_t *m = shared_page();
    init_mutex(m, PTHREAD_MUTEX_NORMAL, 0);
    pid_t pid = fork();
    if (pid == 0) {
        pthread_mutex_lock(m);
        _exit(0);
    }
    reap(pid);
    int r = pthread_mutex_trylock(m);
    report(r == EBUSY, "trylock after the owner exited=%s", err_name(r));
}

/* A robust mutex whose owner process exits reports EOWNERDEAD. */
static void robust_owner_exit(void) {
    pthread_mutex_t *m = shared_page();
    init_mutex(m, PTHREAD_MUTEX_NORMAL, 1);
    pid_t pid = fork();
    if (pid == 0) {
        pthread_mutex_lock(m);
        _exit(0);
    }
    reap(pid);
    int r = pthread_mutex_trylock(m);
    report(r == EOWNERDEAD, "trylock after the owner exited=%s", err_name(r));
}

/* pthread_mutex_timedlock gives up at its deadline. */
static void mutex_timedlock_deadline(void) {
    pthread_mutex_t *m = shared_page();
    init_mutex(m, PTHREAD_MUTEX_NORMAL, 0);
    int gate[2];
    pipe(gate);
    pid_t pid = fork();
    if (pid == 0) {
        pthread_mutex_lock(m);
        write(gate[1], "x", 1);
        usleep(1500000);
        pthread_mutex_unlock(m);
        _exit(0);
    }
    char b;
    read(gate[0], &b, 1);
    double t0 = now_s();
    struct timespec at = realtime_after(0.3);
    int r = pthread_mutex_timedlock(m, &at);
    double dt = now_s() - t0;
    if (r == 0) pthread_mutex_unlock(m);
    reap(pid);
    report(r == ETIMEDOUT && dt < 1.0, "timedlock=%s after %.2f s (deadline 0.30 s)",
           err_name(r), dt);
}

/* A process blocked on a held mutex acquires it once the holder unlocks. */
struct handoff { pthread_mutex_t m; volatile double acquired; };

static void mutex_handoff(void) {
    struct handoff *h = shared_page();
    init_mutex(&h->m, PTHREAD_MUTEX_NORMAL, 0);
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
    usleep(1000);
    double latency = h->acquired - released;
    report(latency >= 0 && latency < 1.0, "acquired %.2f ms after unlock", latency * 1e3);
}

/* Three processes increment a counter under a process-shared mutex. */
static void mutex_lock_counter(void) {
    struct counter *c = shared_page();
    init_mutex(&c->m, PTHREAD_MUTEX_NORMAL, 0);
    int gate[2];
    pipe(gate);
    pid_t kids[3];
    for (int k = 0; k < 3; k++) {
        if ((kids[k] = fork()) == 0) {
            char b;
            close(gate[1]);
            read(gate[0], &b, 1);
            for (int i = 0; i < 100; i++) {
                pthread_mutex_lock(&c->m);
                int v = c->n;
                sched_yield();
                c->n = v + 1;
                pthread_mutex_unlock(&c->m);
                sched_yield();
            }
            _exit(0);
        }
    }
    close(gate[0]);
    write(gate[1], "xxx", 3);
    close(gate[1]);
    for (int k = 0; k < 3; k++) reap(kids[k]);
    usleep(1000);
    report(c->n == 300, "counter=%d of 300", c->n);
}

/* ── Condition variables, read-write locks, barriers ───────────────── */

struct condpair { pthread_mutex_t m; pthread_cond_t c; volatile int flag; volatile int inside; volatile int overlap; };

/* pthread_cond_timedwait on a process-shared condition, signalled by another process. */
static void cond_timedwait_wakeup(void) {
    struct condpair *g = shared_page();
    init_mutex(&g->m, PTHREAD_MUTEX_NORMAL, 0);
    init_cond(&g->c);
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
        struct timespec at = realtime_after(3.0);
        r = pthread_cond_timedwait(&g->c, &g->m, &at);
    }
    pthread_mutex_unlock(&g->m);
    double dt = now_s() - t0;
    reap(pid);
    report(r == 0 && dt < 2.0, "timedwait=%s after %.2f s", err_name(r), dt);
}

static void *cond_waiter(void *arg) {
    struct condpair *g = arg;
    long r = 0;
    pthread_mutex_lock(&g->m);
    while (!g->flag && r == 0) r = pthread_cond_wait(&g->c, &g->m);
    if (r == 0) {
        if (++g->inside != 1) g->overlap = 1;
        usleep(50000);
        g->inside--;
        pthread_mutex_unlock(&g->m);
    }
    return (void *)r;
}

/* Two threads of one process wait on one process-shared condition; a broadcast wakes both. */
static void cond_two_thread_broadcast(void) {
    struct condpair *g = shared_page();
    init_mutex(&g->m, PTHREAD_MUTEX_NORMAL, 0);
    init_cond(&g->c);
    pthread_t a, b;
    pthread_create(&a, NULL, cond_waiter, g);
    pthread_create(&b, NULL, cond_waiter, g);
    usleep(300000);
    pthread_mutex_lock(&g->m);
    g->flag = 1;
    pthread_cond_broadcast(&g->c);
    pthread_mutex_unlock(&g->m);
    void *ra, *rb;
    pthread_join(a, &ra);
    pthread_join(b, &rb);
    report(ra == 0 && rb == 0 && !g->overlap, "waits returned %s and %s; overlap=%d",
           err_name((int)(long)ra), err_name((int)(long)rb), g->overlap);
}

/* pthread_cond_wait on a process-shared condition, signalled by another process. */
static void cond_wait_wakeup(void) {
    struct condpair *g = shared_page();
    init_mutex(&g->m, PTHREAD_MUTEX_NORMAL, 0);
    init_cond(&g->c);
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
    while (!g->flag && r == 0) r = pthread_cond_wait(&g->c, &g->m);
    pthread_mutex_unlock(&g->m);
    double dt = now_s() - t0;
    reap(pid);
    report(r == 0 && dt < 2.0, "wait=%s after %.2f s", err_name(r), dt);
}

/* pthread_rwlock_timedrdlock wakes when a writer in another process unlocks. */
static void rwlock_wakeup(void) {
    pthread_rwlock_t *rw = shared_page();
    pthread_rwlockattr_t a;
    pthread_rwlockattr_init(&a);
    pthread_rwlockattr_setpshared(&a, PTHREAD_PROCESS_SHARED);
    pthread_rwlock_init(rw, &a);
    pthread_rwlock_wrlock(rw);
    pid_t pid = fork();
    if (pid == 0) {
        double t0 = now_s();
        struct timespec at = realtime_after(3.0);
        int r = pthread_rwlock_timedrdlock(rw, &at);
        double dt = now_s() - t0;
        report(r == 0 && dt < 2.0, "timedrdlock=%s after %.2f s", err_name(r), dt);
        _exit(0);
    }
    usleep(200000);
    pthread_rwlock_unlock(rw);
    reap(pid);
}

static void *barrier_thread(void *arg) {
    return (void *)(long)pthread_barrier_wait(arg);
}

/* Two processes meet at a process-shared barrier; one is the serial waiter. */
static void barrier_two_processes(void) {
    pthread_barrier_t *b = shared_page();
    pthread_barrierattr_t a;
    pthread_barrierattr_init(&a);
    pthread_barrierattr_setpshared(&a, PTHREAD_PROCESS_SHARED);
    pthread_barrier_init(b, &a, 2);
    pid_t pid = fork();
    if (pid == 0) {
        usleep(200000);
        int r = pthread_barrier_wait(b);
        _exit(r == PTHREAD_BARRIER_SERIAL_THREAD ? 1 : r == 0 ? 0 : 2);
    }
    int mine = pthread_barrier_wait(b);
    int st = reap(pid);
    int theirs = WIFEXITED(st) ? WEXITSTATUS(st) : 3;
    int serial = (mine == PTHREAD_BARRIER_SERIAL_THREAD) + (theirs == 1);
    report(serial == 1 && theirs < 2 && (mine == 0 || mine == PTHREAD_BARRIER_SERIAL_THREAD),
           "parent result %d, child status %d", mine, theirs);
}

/* Two threads of one process meet at a process-shared barrier. */
static void barrier_two_threads(void) {
    pthread_barrier_t *b = shared_page();
    pthread_barrierattr_t a;
    pthread_barrierattr_init(&a);
    pthread_barrierattr_setpshared(&a, PTHREAD_PROCESS_SHARED);
    pthread_barrier_init(b, &a, 2);
    pthread_t t;
    pthread_create(&t, NULL, barrier_thread, b);
    int mine = pthread_barrier_wait(b);
    void *theirs;
    pthread_join(t, &theirs);
    int serial = (mine == PTHREAD_BARRIER_SERIAL_THREAD)
        + ((long)theirs == PTHREAD_BARRIER_SERIAL_THREAD);
    int ok = (mine == 0 || mine == PTHREAD_BARRIER_SERIAL_THREAD)
        && ((long)theirs == 0 || (long)theirs == PTHREAD_BARRIER_SERIAL_THREAD)
        && serial == 1;
    report(ok, "results %d and %ld", mine, (long)theirs);
}

/* ── Driver ─────────────────────────────────────────────────────────── */

struct test_case { const char *name; void (*run)(void); int deadline_s; };

static const struct test_case cases[] = {
    { "sem-pshared-wakeup", sem_pshared_wakeup, 10 },
    { "sem-open-wakeup", sem_open_wakeup, 10 },
    { "sem-binary-one-holder", sem_binary_one_holder, 20 },
    { "sem-lock-counter", sem_lock_counter, 60 },
    { "mutex-thread-exclusion", mutex_thread_exclusion, 10 },
    { "mutex-errorcheck-foreign-unlock", mutex_errorcheck_foreign_unlock, 10 },
    { "mutex-owner-exit-stalled", mutex_owner_exit_stalled, 10 },
    { "robust-mutex-owner-exit", robust_owner_exit, 10 },
    { "mutex-timedlock-deadline", mutex_timedlock_deadline, 10 },
    { "mutex-handoff", mutex_handoff, 10 },
    { "mutex-lock-counter", mutex_lock_counter, 60 },
    { "cond-wait-wakeup", cond_wait_wakeup, 10 },
    { "cond-timedwait-wakeup", cond_timedwait_wakeup, 10 },
    { "cond-two-thread-broadcast", cond_two_thread_broadcast, 10 },
    { "rwlock-wakeup", rwlock_wakeup, 10 },
    { "barrier-two-processes", barrier_two_processes, 10 },
    { "barrier-two-threads", barrier_two_threads, 10 },
};

/* Run one case in a child; report a hang or a crash as a divergence. */
static void run_case(const struct test_case *c) {
    current_case = c->name;
    fflush(stdout);
    pid_t pid = fork();
    if (pid == 0) {
        c->run();
        fflush(stdout);
        _exit(0);
    }
    double deadline = now_s() + c->deadline_s;
    int status = 0;
    for (;;) {
        pid_t r = waitpid(pid, &status, WNOHANG);
        if (r == pid) break;
        if (r < 0 && errno != EINTR) {
            report(0, "waitpid failed: %s", strerror(errno));
            return;
        }
        if (now_s() > deadline) {
            kill(pid, SIGKILL);
            reap(pid);
            report(0, "did not finish within %d s", c->deadline_s);
            return;
        }
        usleep(20000);
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        report(0, "case process ended abnormally (status 0x%x)", status);
    }
}

int main(int argc, char **argv) {
    for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        if (argc > 1 && strcmp(argv[1], cases[i].name) != 0) continue;
        run_case(&cases[i]);
    }
    printf("PSYNC_SEMANTICS_DONE\n");
    return 0;
}
