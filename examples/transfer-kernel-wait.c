/*
 * transfer-kernel-wait — a blocking read/write/recv/send on a pipe or a
 * pipe-backed socket is a kernel park.
 *
 * When such a call would block, the kernel parks it with the caller's own
 * buffer address and re-executes it whenever the pipe's readiness changes
 * (crates/runtime-core/src/wait_retry.rs). These cases pin the decisions the
 * re-execution must make.
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
#include <sys/socket.h>
#include <sys/time.h>
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

/* A child that sleeps `delay_ms`, writes `msg` to `fd`, and exits. */
static pid_t write_later(int fd, const char *msg, int delay_ms) {
    pid_t pid = fork();
    if (pid < 0)
        fail("setup", "fork");
    if (pid == 0) {
        usleep((useconds_t)delay_ms * 1000);
        if (write(fd, msg, strlen(msg)) != (ssize_t)strlen(msg))
            _exit(2);
        _exit(0);
    }
    return pid;
}

static void reap(pid_t pid) {
    int status;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
    }
}

static void case_read_waits(void) {
    int p[2];
    if (pipe(p) != 0)
        fail("read", "pipe");
    pid_t child = write_later(p[1], "hello", 100);
    char buf[64];
    long long t0 = now_ms();
    ssize_t n = read(p[0], buf, sizeof buf);
    if (n != 5 || memcmp(buf, "hello", 5) != 0)
        fail("read", "did not read the late write");
    if (now_ms() - t0 < 80)
        fail("read", "returned before the write");
    reap(child);
    close(p[0]);
    close(p[1]);
    ok("read");
}

static void case_eof_wakes(void) {
    int p[2];
    if (pipe(p) != 0)
        fail("eof", "pipe");
    pid_t child = fork();
    if (child == 0) {
        usleep(100000);
        _exit(0); /* closes its write end */
    }
    close(p[1]);
    char buf[8];
    if (read(p[0], buf, sizeof buf) != 0)
        fail("eof", "read did not see end of file");
    reap(child);
    close(p[0]);
    ok("eof");
}

static void case_write_waits_for_room(void) {
    int p[2];
    if (pipe(p) != 0)
        fail("write", "pipe");
    /* Fill the pipe without blocking. */
    int flags = fcntl(p[1], F_GETFL);
    fcntl(p[1], F_SETFL, flags | O_NONBLOCK);
    char block[4096];
    memset(block, 'x', sizeof block);
    size_t filled = 0;
    for (;;) {
        ssize_t n = write(p[1], block, sizeof block);
        if (n < 0) {
            if (errno != EAGAIN)
                fail("write", "filling the pipe");
            break;
        }
        filled += (size_t)n;
    }
    fcntl(p[1], F_SETFL, flags);
    pid_t child = fork();
    if (child == 0) {
        usleep(100000);
        char sink[8192];
        size_t drained = 0;
        while (drained < filled + 1) {
            ssize_t n = read(p[0], sink, sizeof sink);
            if (n <= 0)
                _exit(2);
            drained += (size_t)n;
        }
        _exit(0);
    }
    long long t0 = now_ms();
    if (write(p[1], "y", 1) != 1)
        fail("write", "blocking write failed");
    if (now_ms() - t0 < 80)
        fail("write", "returned before there was room");
    reap(child);
    close(p[0]);
    close(p[1]);
    ok("write");
}

static void case_socket(void) {
    int sv[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0)
        fail("socket", "socketpair");
    pid_t child = write_later(sv[1], "ping", 100);
    char buf[16];
    ssize_t n = recv(sv[0], buf, sizeof buf, 0);
    if (n != 4 || memcmp(buf, "ping", 4) != 0)
        fail("socket", "recv did not get the late send");
    reap(child);
    /* SO_RCVTIMEO: POSIX reports the timeout as EAGAIN/EWOULDBLOCK. */
    struct timeval tv = {0, 100000};
    if (setsockopt(sv[0], SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv) != 0)
        fail("socket", "SO_RCVTIMEO");
    long long t0 = now_ms();
    errno = 0;
    n = recv(sv[0], buf, sizeof buf, 0);
    if (n != -1 || (errno != EAGAIN && errno != EWOULDBLOCK))
        fail("socket", "recv timeout did not answer EAGAIN");
    if (now_ms() - t0 < 80)
        fail("socket", "recv timed out early");
    close(sv[0]);
    close(sv[1]);
    ok("socket");
}

static volatile sig_atomic_t usr1;
static long long usr1_at_ms; static pthread_t usr1_thread;
static void on_usr1(int sig) { (void)sig; usr1++; usr1_at_ms = now_ms(); usr1_thread = pthread_self(); }

static void case_signal(int restart) {
    const char *name = restart ? "signal-restart" : "signal-eintr";
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_usr1;
    sa.sa_flags = restart ? SA_RESTART : 0;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGUSR1, &sa, NULL);
    usr1 = 0;
    int p[2];
    if (pipe(p) != 0)
        fail(name, "pipe");
    pid_t me = getpid();
    pid_t poker = fork();
    if (poker == 0) {
        usleep(100000);
        kill(me, SIGUSR1);
        if (restart) {
            usleep(100000);
            if (write(p[1], "z", 1) != 1)
                _exit(2);
        }
        _exit(0);
    }
    char c;
    errno = 0;
    ssize_t n = read(p[0], &c, 1);
    if (restart) {
        if (n != 1 || c != 'z' || usr1 != 1)
            fail(name, "read was not restarted after the handler");
    } else if (n != -1 || errno != EINTR || usr1 != 1) {
        fail(name, "read was not interrupted with EINTR");
    }
    reap(poker);
    close(p[0]);
    close(p[1]);
    sa.sa_handler = SIG_DFL;
    sigaction(SIGUSR1, &sa, NULL);
    ok(name);
}

struct reader {
    int fd;
    atomic_int started;
    ssize_t result;
    char byte;
};

static void *read_one(void *arg) {
    struct reader *r = arg;
    atomic_store(&r->started, 1);
    r->result = read(r->fd, &r->byte, 1);
    return NULL;
}

static void case_pinned_descriptor(void) {
    /* A thread parks reading p[0]; another closes that number and reuses it
     * for a different pipe. The parked read still belongs to the first
     * pipe: a byte written there reaches it, as on Linux. */
    int p[2], q[2];
    if (pipe(p) != 0)
        fail("pinned", "pipe");
    struct reader r = {.fd = p[0]};
    pthread_t thread;
    if (pthread_create(&thread, NULL, read_one, &r) != 0)
        fail("pinned", "pthread_create");
    while (!atomic_load(&r.started))
        usleep(1000);
    usleep(50000);
    close(p[0]);
    if (pipe(q) != 0)
        fail("pinned", "second pipe");
    if (q[0] != p[0] && q[1] != p[0])
        fail("pinned", "the descriptor number was not reused");
    if (write(p[1], "a", 1) != 1)
        fail("pinned", "write to the first pipe");
    pthread_join(thread, NULL);
    if (r.result != 1 || r.byte != 'a')
        fail("pinned", "the parked read followed the reused number");
    close(p[1]);
    close(q[0]);
    close(q[1]);
    ok("pinned");
}

static atomic_int cleanup_ran;
static void on_cleanup(void *arg) { (void)arg; atomic_store(&cleanup_ran, 1); }

static void *cancel_target(void *arg) {
    struct reader *r = arg;
    pthread_cleanup_push(on_cleanup, NULL);
    atomic_store(&r->started, 1);
    r->result = read(r->fd, &r->byte, 1);
    pthread_cleanup_pop(0);
    return NULL;
}

static void case_cancel(void) {
    int p[2];
    if (pipe(p) != 0)
        fail("cancel", "pipe");
    struct reader r = {.fd = p[0]};
    atomic_store(&cleanup_ran, 0);
    pthread_t thread;
    if (pthread_create(&thread, NULL, cancel_target, &r) != 0)
        fail("cancel", "pthread_create");
    while (!atomic_load(&r.started))
        usleep(1000);
    usleep(50000);
    pthread_cancel(thread);
    void *result;
    pthread_join(thread, &result);
    if (result != PTHREAD_CANCELED || !atomic_load(&cleanup_ran))
        fail("cancel", "a blocked read was not a cancellation point");
    close(p[0]);
    close(p[1]);
    ok("cancel");
}

/* A process-directed signal that becomes pending while the only thread able
 * to take it runs user code (no syscall to deliver it at). That thread's
 * next call is a read that parks: the signal is already pending when the
 * park is made, and must end it with EINTR at once, not when some later
 * event happens to be drained. A watchdog writes a byte after 3 s, so a
 * missed decision shows up as a successful read. */
static atomic_int pending_sent;
static long long pending_sent_at;
static int pending_pipe[2];
struct pending_result { ssize_t n; int err; long long ms; long long t0; };

static void *pending_sender(void *arg) {
    (void)arg;
    usleep(100000);
    pending_sent_at = now_ms();
    kill(getpid(), SIGUSR1);
    atomic_store(&pending_sent, 1);
    return NULL;
}

static void *pending_reader(void *arg) {
    struct pending_result *r = arg;
    sigset_t unblock;
    sigemptyset(&unblock);
    sigaddset(&unblock, SIGUSR1);
    pthread_sigmask(SIG_UNBLOCK, &unblock, NULL);
    while (!atomic_load(&pending_sent)) {
        /* spin: no syscall, so the signal cannot be delivered here */
    }
    /* No syscall between the spin and the read: a clock read here would be
     * the syscall that delivers the signal, and the read would not park
     * with it pending. The interval is measured from the sender's kill. */
    char c;
    errno = 0;
    r->n = read(pending_pipe[0], &c, 1);
    r->err = errno;
    r->t0 = pending_sent_at;
    r->ms = now_ms() - pending_sent_at;
    return NULL;
}

static void *late_writer(void *arg) {
    int fd = *(int *)arg;
    sleep(3);
    if (write(fd, "w", 1) != 1) {
    }
    return NULL;
}

static void case_signal_pending_at_park(void) {
    const char *name = "signal-pending-at-park";
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_usr1;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGUSR1, &sa, NULL);
    usr1 = 0;
    atomic_store(&pending_sent, 0);
    sigset_t block, old;
    sigemptyset(&block);
    sigaddset(&block, SIGUSR1);
    pthread_sigmask(SIG_BLOCK, &block, &old); /* threads below inherit it */
    if (pipe(pending_pipe) != 0)
        fail(name, "pipe");
    struct pending_result r = {0};
    pthread_t reader, sender, watchdog;
    if (pthread_create(&reader, NULL, pending_reader, &r) != 0 ||
        pthread_create(&sender, NULL, pending_sender, NULL) != 0 ||
        pthread_create(&watchdog, NULL, late_writer, &pending_pipe[1]) != 0)
        fail(name, "pthread_create");
    pthread_join(reader, NULL);
    pthread_join(sender, NULL);
    pthread_join(watchdog, NULL);
    if (r.n != -1 || r.err != EINTR || usr1 != 1) {
        printf("detail n=%zd err=%d usr1=%d ms=%lld handler_at=+%lld reader_thread=%d\n", r.n, r.err, (int)usr1, r.ms, usr1_at_ms - r.t0, pthread_equal(usr1_thread, reader));
        fail(name, "a signal pending at park time did not interrupt the read");
    }
    if (r.ms > 2000)
        fail(name, "the pending signal was decided late");
    close(pending_pipe[0]);
    close(pending_pipe[1]);
    pthread_sigmask(SIG_SETMASK, &old, NULL);
    sa.sa_handler = SIG_DFL;
    sigaction(SIGUSR1, &sa, NULL);
    ok(name);
}

/* SO_RCVTIMEO of 1 us: the deadline has passed by the time the park is
 * made. The receive must answer EAGAIN promptly; a park whose deadline is
 * never armed as a host timer would wait for the watchdog's byte. */
static void case_expired_timeout(void) {
    const char *name = "expired-timeout";
    int sv[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0)
        fail(name, "socketpair");
    struct timeval tv = {0, 1};
    if (setsockopt(sv[0], SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv) != 0)
        fail(name, "SO_RCVTIMEO");
    pthread_t watchdog;
    if (pthread_create(&watchdog, NULL, late_writer, &sv[1]) != 0)
        fail(name, "pthread_create");
    char buf[4];
    long long t0 = now_ms();
    errno = 0;
    ssize_t n = recv(sv[0], buf, sizeof buf, 0);
    long long ms = now_ms() - t0;
    pthread_join(watchdog, NULL);
    if (n != -1 || (errno != EAGAIN && errno != EWOULDBLOCK))
        fail(name, "an expired receive timeout did not answer EAGAIN");
    if (ms > 2000)
        fail(name, "the expired timeout was decided late");
    close(sv[0]);
    close(sv[1]);
    ok(name);
}

/* Two processes trade one byte 2000 times over two pipes, so nearly every
 * read parks and is made ready by the peer's very next call. A readiness
 * decision that waits for an unrelated event shows up as a hang (the
 * harness timeout) or as a far slower run. */
static void case_ping_pong(void) {
    const char *name = "ping-pong";
    int ab[2], ba[2];
    if (pipe(ab) != 0 || pipe(ba) != 0)
        fail(name, "pipe");
    pid_t child = fork();
    if (child < 0)
        fail(name, "fork");
    if (child == 0) {
        char c;
        for (int i = 0; i < 2000; i++) {
            if (read(ab[0], &c, 1) != 1 || write(ba[1], &c, 1) != 1)
                _exit(2);
        }
        _exit(0);
    }
    char c = 'p';
    for (int i = 0; i < 2000; i++) {
        if (write(ab[1], &c, 1) != 1 || read(ba[0], &c, 1) != 1)
            fail(name, "round trip");
    }
    int status;
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status) != 0)
        fail(name, "the peer failed");
    close(ab[0]); close(ab[1]); close(ba[0]); close(ba[1]);
    ok(name);
}

/* A process-directed signal pending while its target, thread C, runs user
 * code; C then blocks it. That mask change moves the signal onto thread B,
 * already parked in a read with the signal unblocked -- no new signal is
 * generated. B must be interrupted promptly (EINTR, handler on B), not left
 * parked until an unrelated event; a watchdog byte after 3 s exposes a
 * stranded B as a successful read. C and the sender spin instead of
 * blocking so no other park or thread exit can rescue B by accident. */
static atomic_int retarget_go, retarget_b_done, retarget_b_parked;
static long long retarget_sent_at;
static int retarget_pipe[2];
struct retarget_result { ssize_t n; int err; long long ms; int on_b; };
static struct retarget_result retarget_r;
static pthread_t retarget_b;

static void *retarget_thread_c(void *arg) {
    (void)arg;
    sigset_t set;
    sigemptyset(&set);
    sigaddset(&set, SIGUSR1);
    pthread_sigmask(SIG_UNBLOCK, &set, NULL);
    while (!atomic_load(&retarget_go)) {
    }
    /* The signal targets this thread now; block it without taking it. */
    pthread_sigmask(SIG_BLOCK, &set, NULL);
    while (!atomic_load(&retarget_b_done)) {
    }
    return NULL;
}

static void *retarget_thread_b(void *arg) {
    (void)arg;
    sigset_t set;
    sigemptyset(&set);
    sigaddset(&set, SIGUSR1);
    pthread_sigmask(SIG_UNBLOCK, &set, NULL);
    atomic_store(&retarget_b_parked, 1);
    char c;
    errno = 0;
    retarget_r.n = read(retarget_pipe[0], &c, 1);
    retarget_r.err = errno;
    retarget_r.ms = now_ms() - retarget_sent_at;
    atomic_store(&retarget_b_done, 1);
    return NULL;
}

static void *retarget_sender(void *arg) {
    (void)arg;
    while (!atomic_load(&retarget_b_parked)) {
    }
    usleep(200000); /* let B park */
    retarget_sent_at = now_ms();
    kill(getpid(), SIGUSR1);
    atomic_store(&retarget_go, 1);
    while (!atomic_load(&retarget_b_done)) {
    }
    return NULL;
}

static void case_signal_retargeted_to_parked_thread(void) {
    const char *name = "signal-retargeted";
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_usr1;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGUSR1, &sa, NULL);
    usr1 = 0;
    atomic_store(&retarget_go, 0);
    atomic_store(&retarget_b_done, 0);
    atomic_store(&retarget_b_parked, 0);
    sigset_t block, old;
    sigemptyset(&block);
    sigaddset(&block, SIGUSR1);
    pthread_sigmask(SIG_BLOCK, &block, &old);
    if (pipe(retarget_pipe) != 0)
        fail(name, "pipe");
    pthread_t c, sender, watchdog;
    /* C is created before B, so while both accept SIGUSR1 the process-
     * directed signal is C's (the first accepting thread). */
    if (pthread_create(&c, NULL, retarget_thread_c, NULL) != 0 ||
        pthread_create(&retarget_b, NULL, retarget_thread_b, NULL) != 0 ||
        pthread_create(&sender, NULL, retarget_sender, NULL) != 0 ||
        pthread_create(&watchdog, NULL, late_writer, &retarget_pipe[1]) != 0)
        fail(name, "pthread_create");
    pthread_join(retarget_b, NULL);
    pthread_join(c, NULL);
    pthread_join(sender, NULL);
    pthread_join(watchdog, NULL);
    if (retarget_r.n != -1 || retarget_r.err != EINTR || usr1 != 1 ||
        !pthread_equal(usr1_thread, retarget_b)) {
        printf("detail n=%zd err=%d usr1=%d ms=%lld on_b=%d\n", retarget_r.n, retarget_r.err,
               (int)usr1, retarget_r.ms, pthread_equal(usr1_thread, retarget_b));
        fail(name, "a signal moved onto a parked thread did not interrupt it");
    }
    if (retarget_r.ms > 2000)
        fail(name, "the retargeted signal was decided late");
    close(retarget_pipe[0]);
    close(retarget_pipe[1]);
    pthread_sigmask(SIG_SETMASK, &old, NULL);
    sa.sa_handler = SIG_DFL;
    sigaction(SIGUSR1, &sa, NULL);
    ok(name);
}

int main(void) {
    case_read_waits();
    case_eof_wakes();
    case_write_waits_for_room();
    case_socket();
    case_signal(0);
    case_signal(1);
    case_pinned_descriptor();
    case_cancel();
    case_signal_pending_at_park();
    case_expired_timeout();
    case_ping_pong();
    case_signal_retargeted_to_parked_thread();
    puts("PASS");
    return 0;
}
