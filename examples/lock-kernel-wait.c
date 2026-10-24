/*
 * lock-kernel-wait — a blocking advisory lock is a kernel park.
 *
 * fcntl(F_SETLKW / F_OFD_SETLKW) and blocking flock() park in the kernel with
 * the request; the kernel re-executes it whenever advisory-lock state
 * changes (crates/runtime-core/src/wait_retry.rs). Before, the host re-ran the
 * syscall every 10 ms. These cases pin the decisions that replaced that.
 *
 * Output: one "ok <case>" line per case, then "PASS". Any failure prints
 * "FAIL <case>: <detail>" and exits 1.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define PATH "/tmp/lock-kernel-wait.dat"

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

static int open_file(void) {
    int fd = open(PATH, O_RDWR | O_CREAT, 0644);
    if (fd < 0)
        fail("setup", "open");
    return fd;
}

static int set_lock(int fd, int cmd, short type) {
    struct flock fl;
    memset(&fl, 0, sizeof(fl));
    fl.l_type = type;
    fl.l_whence = SEEK_SET;
    return fcntl(fd, cmd, &fl);
}

/* A child holds a write lock for `hold_ms`, then exits (which releases it).
 * Returns once the child holds the lock. */
static pid_t hold_in_child(int hold_ms, int use_flock) {
    int ready[2];
    if (pipe(ready) != 0)
        fail("setup", "pipe");
    pid_t pid = fork();
    if (pid < 0)
        fail("setup", "fork");
    if (pid == 0) {
        close(ready[0]);
        int fd = open_file();
        int rc = use_flock ? flock(fd, LOCK_EX) : set_lock(fd, F_SETLK, F_WRLCK);
        if (rc != 0)
            _exit(2);
        if (write(ready[1], "x", 1) != 1)
            _exit(3);
        usleep((useconds_t)hold_ms * 1000);
        _exit(0);
    }
    close(ready[1]);
    char byte;
    if (read(ready[0], &byte, 1) != 1)
        fail("setup", "child did not take the lock");
    close(ready[0]);
    return pid;
}

static void reap(pid_t pid) {
    int status;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
    }
}

static void case_setlkw_waits_for_release(void) {
    pid_t holder = hold_in_child(150, 0);
    int fd = open_file();
    long long t0 = now_ms();
    if (set_lock(fd, F_SETLKW, F_WRLCK) != 0)
        fail("setlkw", "F_SETLKW failed");
    long long elapsed = now_ms() - t0;
    if (elapsed < 100)
        fail("setlkw", "acquired before the holder released");
    set_lock(fd, F_SETLK, F_UNLCK);
    close(fd);
    reap(holder);
    ok("setlkw");
}

static void case_nonblocking_answers_now(void) {
    pid_t holder = hold_in_child(300, 0);
    int fd = open_file();
    errno = 0;
    if (set_lock(fd, F_SETLK, F_WRLCK) != -1 || (errno != EAGAIN && errno != EACCES))
        fail("nonblocking", "F_SETLK did not fail with EAGAIN/EACCES");
    struct flock fl;
    memset(&fl, 0, sizeof(fl));
    fl.l_type = F_WRLCK;
    fl.l_whence = SEEK_SET;
    if (fcntl(fd, F_GETLK, &fl) != 0 || fl.l_type != F_WRLCK || fl.l_pid != holder)
        fail("nonblocking", "F_GETLK did not report the holder");
    close(fd);
    reap(holder);
    ok("nonblocking");
}

static void case_flock(void) {
    pid_t holder = hold_in_child(150, 1);
    int fd = open_file();
    errno = 0;
    if (flock(fd, LOCK_EX | LOCK_NB) != -1 || errno != EWOULDBLOCK)
        fail("flock", "LOCK_NB did not fail with EWOULDBLOCK");
    long long t0 = now_ms();
    if (flock(fd, LOCK_EX) != 0)
        fail("flock", "blocking flock failed");
    if (now_ms() - t0 < 100)
        fail("flock", "acquired before the holder released");
    flock(fd, LOCK_UN);
    close(fd);
    reap(holder);
    ok("flock");
}

static volatile sig_atomic_t alarms;
static void on_alarm(int sig) { (void)sig; alarms++; }

static void case_signal(int restart) {
    const char *name = restart ? "signal-restart" : "signal-eintr";
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = on_alarm;
    sa.sa_flags = restart ? SA_RESTART : 0;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGUSR1, &sa, NULL);
    alarms = 0;
    pid_t holder = hold_in_child(restart ? 300 : 2000, 0);
    pid_t me = getpid();
    pid_t poker = fork();
    if (poker == 0) {
        usleep(100000);
        kill(me, SIGUSR1);
        _exit(0);
    }
    int fd = open_file();
    errno = 0;
    int rc = set_lock(fd, F_SETLKW, F_WRLCK);
    if (restart) {
        if (rc != 0 || alarms != 1)
            fail(name, "F_SETLKW was not restarted after the handler");
    } else if (rc != -1 || errno != EINTR || alarms != 1) {
        fail(name, "F_SETLKW was not interrupted with EINTR");
    }
    close(fd);
    kill(holder, SIGKILL);
    reap(poker);
    reap(holder);
    sa.sa_handler = SIG_DFL;
    sigaction(SIGUSR1, &sa, NULL);
    ok(name);
}

static atomic_int cleanup_ran;
static void on_cleanup(void *arg) { (void)arg; atomic_store(&cleanup_ran, 1); }

static void *lock_thread(void *arg) {
    atomic_int *started = arg;
    int fd = open_file();
    pthread_cleanup_push(on_cleanup, NULL);
    atomic_store(started, 1);
    set_lock(fd, F_SETLKW, F_WRLCK);
    pthread_cleanup_pop(0);
    return NULL;
}

static void case_cancel(void) {
    pid_t holder = hold_in_child(2000, 0);
    atomic_int started = 0;
    atomic_store(&cleanup_ran, 0);
    pthread_t thread;
    if (pthread_create(&thread, NULL, lock_thread, &started) != 0)
        fail("cancel", "pthread_create");
    while (!atomic_load(&started))
        usleep(1000);
    usleep(50000);
    pthread_cancel(thread);
    void *result;
    pthread_join(thread, &result);
    if (result != PTHREAD_CANCELED || !atomic_load(&cleanup_ran))
        fail("cancel", "F_SETLKW was not a cancellation point");
    kill(holder, SIGKILL);
    reap(holder);
    ok("cancel");
}

int main(void) {
    int fd = open_file();
    close(fd);
    case_setlkw_waits_for_release();
    case_nonblocking_answers_now();
    case_flock();
    case_signal(0);
    case_signal(1);
    case_cancel();
    unlink(PATH);
    puts("PASS");
    return 0;
}
