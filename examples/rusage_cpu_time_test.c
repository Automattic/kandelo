/*
 * CPU-time accounting through getrusage(), times(), clock(), the CPU-time
 * clocks and wait4()'s resource usage.
 *
 * Kandelo measures a thread's user time as the time it spends outside
 * syscalls and its system time as the time the kernel spends handling its
 * syscalls; time blocked in a syscall is neither. These checks use bounds
 * wide enough for a loaded machine: they establish that busy computation is
 * charged, that blocking is not, and that every interface reports the same
 * accounting.
 *
 * Exits 1 at the first failure ("FAIL ..."); prints RUSAGE_CPU_TIME_PASS.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/times.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define CHECK(cond, ...)                                                   \
    do {                                                                   \
        if (!(cond)) {                                                     \
            fprintf(stderr, "FAIL line %d: ", __LINE__);                   \
            fprintf(stderr, __VA_ARGS__);                                  \
            fprintf(stderr, " (errno=%d %s)\n", errno, strerror(errno));   \
            exit(1);                                                       \
        }                                                                  \
    } while (0)

#define MS 1000000LL

static long long ts_ns(struct timespec ts) {
    return (long long)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

static long long tv_ns(struct timeval tv) {
    return (long long)tv.tv_sec * 1000000000LL + (long long)tv.tv_usec * 1000;
}

static long long clock_ns(clockid_t id) {
    struct timespec ts;
    CHECK(clock_gettime(id, &ts) == 0, "clock_gettime(%d)", (int)id);
    return ts_ns(ts);
}

struct usage {
    long long user, sys;
};

static struct usage usage_of(int who) {
    struct rusage ru;
    memset(&ru, 0xa5, sizeof ru);
    CHECK(getrusage(who, &ru) == 0, "getrusage(%d)", who);
    CHECK(ru.ru_utime.tv_usec >= 0 && ru.ru_utime.tv_usec < 1000000 &&
              ru.ru_stime.tv_usec >= 0 && ru.ru_stime.tv_usec < 1000000,
          "getrusage(%d) timevals are normalized", who);
    return (struct usage){tv_ns(ru.ru_utime), tv_ns(ru.ru_stime)};
}

static volatile unsigned long long sink;

/* Compute without syscalls for at least `ns` of wall time, polling the
 * clock only every few million iterations. Returns the wall time spent. */
static long long busy(long long ns) {
    long long start = clock_ns(CLOCK_MONOTONIC), now;
    unsigned long long x = 1;
    do {
        for (int i = 0; i < 2000000; i++) x = x * 6364136223846793005ULL + 1;
        now = clock_ns(CLOCK_MONOTONIC);
    } while (now - start < ns);
    sink = x;
    return now - start;
}

static void sleep_ms(long ms) {
    struct timespec ts = {ms / 1000, (ms % 1000) * 1000000L};
    CHECK(nanosleep(&ts, NULL) == 0, "nanosleep");
}

static void test_busy_and_blocked(void) {
    /* busy() reads CLOCK_MONOTONIC as it runs, so a little of its time is
     * spent in syscalls: the loop's whole time is user plus system time,
     * and most of it is user time. */
    struct usage before = usage_of(RUSAGE_SELF);
    long long spent = busy(300 * MS);
    struct usage after = usage_of(RUSAGE_SELF);
    long long user = after.user - before.user;
    long long total = user + (after.sys - before.sys);
    CHECK(total >= spent - 5 * MS && total <= spent + 500 * MS,
          "busy loop of %lld ms charged %lld ms of CPU time", spent / MS,
          total / MS);
    CHECK(user >= spent * 3 / 4, "busy loop of %lld ms charged %lld ms of "
          "user time", spent / MS, user / MS);

    before = usage_of(RUSAGE_SELF);
    sleep_ms(300);
    after = usage_of(RUSAGE_SELF);
    CHECK(after.user - before.user < 100 * MS,
          "a 300 ms sleep charged %lld ms of user time",
          (after.user - before.user) / MS);
    CHECK(after.sys - before.sys < 100 * MS,
          "a 300 ms sleep charged %lld ms of system time",
          (after.sys - before.sys) / MS);

    before = usage_of(RUSAGE_SELF);
    for (int i = 0; i < 20000; i++) (void)getppid();
    after = usage_of(RUSAGE_SELF);
    CHECK(after.sys > before.sys, "20000 syscalls charged system time");
    CHECK(after.user >= before.user && after.sys >= before.sys,
          "usage never decreases");
}

static void test_clocks_agree(void) {
    struct usage u0 = usage_of(RUSAGE_SELF);
    long long p0 = clock_ns(CLOCK_PROCESS_CPUTIME_ID);
    clock_t c0 = clock();
    long long t0 = clock_ns(CLOCK_THREAD_CPUTIME_ID);
    CHECK(c0 != (clock_t)-1, "clock()");
    CHECK(p0 >= u0.user + u0.sys, "the process clock includes all usage");

    long long spent = busy(200 * MS);

    long long t1 = clock_ns(CLOCK_THREAD_CPUTIME_ID);
    clock_t c1 = clock();
    long long p1 = clock_ns(CLOCK_PROCESS_CPUTIME_ID);
    struct usage u1 = usage_of(RUSAGE_SELF);
    long long dp = p1 - p0, dt = t1 - t0;
    long long dc = (long long)(c1 - c0) * 1000000000LL / CLOCKS_PER_SEC;
    long long du = (u1.user + u1.sys) - (u0.user + u0.sys);
    CHECK(dp >= spent - 5 * MS, "CLOCK_PROCESS_CPUTIME_ID advanced %lld ms "
          "over %lld ms of computation", dp / MS, spent / MS);
    CHECK(dt >= spent - 5 * MS, "CLOCK_THREAD_CPUTIME_ID advanced %lld ms "
          "over %lld ms of computation", dt / MS, spent / MS);
    CHECK(dc >= spent - 5 * MS, "clock() advanced %lld ms over %lld ms of "
          "computation", dc / MS, spent / MS);
    CHECK(du >= dp - 5 * MS && du <= dp + 100 * MS,
          "getrusage (%lld ms) and the process clock (%lld ms) agree",
          du / MS, dp / MS);

    long long b0 = clock_ns(CLOCK_PROCESS_CPUTIME_ID);
    sleep_ms(200);
    long long b1 = clock_ns(CLOCK_PROCESS_CPUTIME_ID);
    CHECK(b1 - b0 < 100 * MS, "a 200 ms sleep advanced the process clock "
          "%lld ms", (b1 - b0) / MS);

    clockid_t self;
    CHECK(clock_getcpuclockid(getpid(), &self) == 0, "clock_getcpuclockid");
    long long s = clock_ns(self);
    long long p = clock_ns(CLOCK_PROCESS_CPUTIME_ID);
    CHECK(s <= p && p - s < 50 * MS, "the encoded clock of this process "
          "(%lld ms) reads the process clock (%lld ms)", s / MS, p / MS);
}

static void test_times(void) {
    long tick = sysconf(_SC_CLK_TCK);
    CHECK(tick > 0, "sysconf(_SC_CLK_TCK)");
    struct tms a, b;
    errno = 0;
    clock_t r0 = times(&a);
    CHECK(r0 != (clock_t)-1, "times()");
    long long spent = busy(200 * MS);
    clock_t r1 = times(&b);
    CHECK(r1 != (clock_t)-1, "times()");
    long long elapsed = (long long)(r1 - r0) * 1000000000LL / tick;
    long long cpu = (long long)((b.tms_utime + b.tms_stime) -
                                (a.tms_utime + a.tms_stime)) *
                    1000000000LL / tick;
    CHECK(elapsed >= spent - 20 * MS, "times() elapsed %lld ms over %lld ms",
          elapsed / MS, spent / MS);
    CHECK(cpu >= spent - 30 * MS, "tms_utime + tms_stime advanced %lld ms "
          "over %lld ms of computation", cpu / MS, spent / MS);

    struct usage u = usage_of(RUSAGE_SELF);
    long long tms_user = (long long)b.tms_utime * 1000000000LL / tick;
    CHECK(tms_user <= u.user && u.user - tms_user < 100 * MS,
          "tms_utime (%lld ms) agrees with ru_utime (%lld ms)", tms_user / MS,
          u.user / MS);
}

static void *thread_busy(void *arg) {
    (void)arg;
    busy(300 * MS);
    return NULL;
}

static void test_threads(void) {
    long long main0 = clock_ns(CLOCK_THREAD_CPUTIME_ID);
    long long proc0 = clock_ns(CLOCK_PROCESS_CPUTIME_ID);
    pthread_t t;
    CHECK(pthread_create(&t, NULL, thread_busy, NULL) == 0, "pthread_create");
    clockid_t tclock;
    CHECK(pthread_getcpuclockid(t, &tclock) == 0, "pthread_getcpuclockid");
    CHECK(pthread_join(t, NULL) == 0, "pthread_join");
    long long main1 = clock_ns(CLOCK_THREAD_CPUTIME_ID);
    long long proc1 = clock_ns(CLOCK_PROCESS_CPUTIME_ID);
    CHECK(proc1 - proc0 >= 250 * MS, "a thread's computation (%lld ms) "
          "counts toward the process", (proc1 - proc0) / MS);
    CHECK(main1 - main0 < 150 * MS, "the joining thread's clock advanced "
          "%lld ms while it waited", (main1 - main0) / MS);

    pthread_t live;
    CHECK(pthread_create(&live, NULL, thread_busy, NULL) == 0,
          "pthread_create");
    CHECK(pthread_getcpuclockid(live, &tclock) == 0, "pthread_getcpuclockid");
    sleep_ms(150);
    long long seen = clock_ns(tclock);
    CHECK(seen > 0, "another thread's CPU clock reads its time");
    CHECK(pthread_join(live, NULL) == 0, "pthread_join");
}

static void test_children(void) {
    struct usage c0 = usage_of(RUSAGE_CHILDREN);
    struct tms before;
    CHECK(times(&before) != (clock_t)-1, "times()");
    struct usage self0 = usage_of(RUSAGE_SELF);

    pid_t pid = fork();
    CHECK(pid >= 0, "fork");
    if (pid == 0) {
        /* The grandchild's usage reaches the parent only through the child
         * that waited for it. */
        pid_t grandchild = fork();
        if (grandchild < 0) _exit(2);
        if (grandchild == 0) {
            busy(150 * MS);
            _exit(0);
        }
        busy(150 * MS);
        int st;
        if (waitpid(grandchild, &st, 0) != grandchild) _exit(3);
        _exit(0);
    }

    struct usage pending = usage_of(RUSAGE_CHILDREN);
    CHECK(pending.user == c0.user && pending.sys == c0.sys,
          "a running child is not in RUSAGE_CHILDREN");

    int status;
    struct rusage ru;
    CHECK(wait4(pid, &status, 0, &ru) == pid, "wait4");
    CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 0, "child status %#x",
          status);
    long long reported = tv_ns(ru.ru_utime) + tv_ns(ru.ru_stime);
    CHECK(reported >= 280 * MS, "wait4 reports %lld ms of CPU time for a "
          "child and grandchild that computed 300 ms", reported / MS);

    struct usage c1 = usage_of(RUSAGE_CHILDREN);
    CHECK(c1.user - c0.user == tv_ns(ru.ru_utime) &&
              c1.sys - c0.sys == tv_ns(ru.ru_stime),
          "RUSAGE_CHILDREN grew by exactly what wait4 reported");
    struct usage self1 = usage_of(RUSAGE_SELF);
    CHECK(self1.user - self0.user < 150 * MS, "the waiting parent was not "
          "charged its child's time (%lld ms)", (self1.user - self0.user) / MS);

    long tick = sysconf(_SC_CLK_TCK);
    struct tms after;
    CHECK(times(&after) != (clock_t)-1, "times()");
    long long cut = (long long)(after.tms_cutime - before.tms_cutime) *
                    1000000000LL / tick;
    long long child_user = c1.user - c0.user;
    CHECK(cut >= child_user - 20 * MS && cut <= child_user + 20 * MS,
          "tms_cutime (%lld ms) agrees with RUSAGE_CHILDREN (%lld ms)",
          cut / MS, child_user / MS);
}

static void test_killed_child(void) {
    pid_t pid = fork();
    CHECK(pid >= 0, "fork");
    if (pid == 0) {
        for (;;) busy(1000 * MS);
    }
    sleep_ms(300);
    CHECK(kill(pid, SIGKILL) == 0, "kill");
    int status;
    struct rusage ru;
    CHECK(wait4(pid, &status, 0, &ru) == pid, "wait4");
    CHECK(WIFSIGNALED(status) && WTERMSIG(status) == SIGKILL,
          "killed child status %#x", status);
    CHECK(tv_ns(ru.ru_utime) + tv_ns(ru.ru_stime) >= 150 * MS, "a child "
          "killed while computing reports %lld ms of CPU time",
          (tv_ns(ru.ru_utime) + tv_ns(ru.ru_stime)) / MS);
}

static void test_unwaited_child(void) {
    /* POSIX counts only children that terminated and were waited for. */
    struct usage c0 = usage_of(RUSAGE_CHILDREN);
    struct sigaction ign = {.sa_handler = SIG_IGN}, old;
    CHECK(sigaction(SIGCHLD, &ign, &old) == 0, "sigaction");
    pid_t pid = fork();
    CHECK(pid >= 0, "fork");
    if (pid == 0) {
        busy(100 * MS);
        _exit(0);
    }
    errno = 0;
    CHECK(waitpid(pid, NULL, 0) == -1 && errno == ECHILD,
          "an auto-reaped child is not waitable");
    CHECK(sigaction(SIGCHLD, &old, NULL) == 0, "sigaction");
    struct usage c1 = usage_of(RUSAGE_CHILDREN);
    CHECK(c1.user == c0.user && c1.sys == c0.sys,
          "an auto-reaped child is not in RUSAGE_CHILDREN");
}

static void test_errors(void) {
    struct rusage ru;
    errno = 0;
    CHECK(getrusage(12345, &ru) == -1 && errno == EINVAL,
          "getrusage(12345)");
    clockid_t none;
    CHECK(clock_getcpuclockid(0x0ffffff0, &none) == ESRCH,
          "clock_getcpuclockid of an absent process is ESRCH");
}

int main(void) {
    test_busy_and_blocked();
    test_clocks_agree();
    test_times();
    test_threads();
    test_children();
    test_killed_child();
    test_unwaited_child();
    test_errors();
    puts("RUSAGE_CPU_TIME_PASS");
    return 0;
}
