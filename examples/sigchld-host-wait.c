/*
 * A caught SIGCHLD must interrupt a parent blocked in a wait the host still
 * owns (poll, select, epoll_wait, accept) with EINTR, even when the kernel
 * reaps the child in the same step that announces its exit: an SA_NOCLDWAIT
 * auto-reap, or another thread of the parent parked in waitpid.
 *
 * Before the kernel owned wait4/waitid and announced exits itself, the host
 * routed SIGCHLD to the parent only after its own exit bookkeeping, and when
 * the zombie was already gone (auto-reaped, or consumed by the waitpid
 * thread) the parent's host-owned wait was never interrupted: the handler
 * ran only when the wait ended for some other reason.
 *
 * Each case runs on the main thread and again on a second thread while the
 * main thread blocks SIGCHLD, so the process-directed signal can only be
 * delivered to the waiting thread. A watchdog makes the descriptor ready
 * after WATCHDOG_MS (accept: SO_RCVTIMEO of the same length), so a missed
 * interruption shows up as a wait that ended some other way instead of
 * hanging the test.
 *
 * Output: "ok <case>" per case, then PASS; or "FAIL <case>: <detail>".
 */
#define _GNU_SOURCE
#include <errno.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define WATCHDOG_MS 8000

static volatile sig_atomic_t chld;
static void on_chld(int s) { (void)s; chld++; }
static long long now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1000LL + t.tv_nsec / 1000000; }
static void fail(const char *c, const char *d) { printf("FAIL %s: %s\n", c, d); fflush(stdout); exit(1); }

struct wd { int fd; int ms; };
static void *watchdog(void *a) { struct wd *w = a; usleep(w->ms * 1000); if (write(w->fd, "x", 1) < 0) {} return NULL; }
static atomic_int waiter_ready;
static void *reaper(void *a) { (void)a; atomic_store(&waiter_ready, 1); int st; while (waitpid(-1, &st, 0) < 0 && errno == EINTR) {} return NULL; }

static void spawn_exiting_child(void) {
    pid_t c = fork();
    if (c == 0) { usleep(150000); _exit(0); }
    if (c < 0) fail("setup", "fork");
}

enum { POLL, SELECT, EPOLL, ACCEPT };
static const char *names[] = {"poll", "select", "epoll", "accept"};

static void run_case(int kind, int nocldwait, const char *prefix) {
    char name[64];
    snprintf(name, sizeof name, "%s%s-%s", prefix, names[kind], nocldwait ? "autoreap" : "waiter");
    struct sigaction sa; memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_chld; sigemptyset(&sa.sa_mask);
    sa.sa_flags = nocldwait ? SA_NOCLDWAIT : 0;
    sigaction(SIGCHLD, &sa, NULL);
    chld = 0;
    int p[2]; if (pipe(p)) fail(name, "pipe");
    int lfd = -1, wfd = p[1], rfd = p[0];
    if (kind == ACCEPT) {
        lfd = socket(AF_INET, SOCK_STREAM, 0);
        struct sockaddr_in a = {.sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
        if (lfd < 0 || bind(lfd, (void *)&a, sizeof a) || listen(lfd, 1)) fail(name, "listen");
        rfd = lfd;
    }
    pthread_t wt, rt;
    struct wd w = {wfd, WATCHDOG_MS};
    if (kind != ACCEPT) pthread_create(&wt, NULL, watchdog, &w);
    if (!nocldwait) { atomic_store(&waiter_ready, 0); pthread_create(&rt, NULL, reaper, NULL); while (!atomic_load(&waiter_ready)) usleep(1000); usleep(20000); }
    spawn_exiting_child();
    long long t0 = now_ms();
    int r = 0, err = 0;
    errno = 0;
    if (kind == POLL) { struct pollfd pf = {rfd, POLLIN, 0}; r = poll(&pf, 1, -1); }
    else if (kind == SELECT) { fd_set s; FD_ZERO(&s); FD_SET(rfd, &s); r = select(rfd + 1, &s, NULL, NULL, NULL); }
    else if (kind == EPOLL) { int ep = epoll_create1(0); struct epoll_event e = {.events = EPOLLIN, .data.fd = rfd}; epoll_ctl(ep, EPOLL_CTL_ADD, rfd, &e); r = epoll_wait(ep, &e, 1, -1); close(ep); }
    else { struct timeval tv = {WATCHDOG_MS / 1000, 0}; setsockopt(lfd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv); r = accept(lfd, NULL, NULL); }
    err = errno;
    long long ms = now_ms() - t0;
    /* The watchdog is only a backstop; stop it (usleep is a cancellation
     * point) so a passing case does not wait out WATCHDOG_MS. */
    if (kind != ACCEPT) { pthread_cancel(wt); pthread_join(wt, NULL); }
    if (!nocldwait) pthread_join(rt, NULL);
    if (r != -1 || err != EINTR || chld < 1) {
        printf("detail %s r=%d errno=%d chld=%d ms=%lld\n", name, r, err, (int)chld, ms);
        fail(name, "SIGCHLD did not interrupt the wait promptly");
    }
    close(p[0]); close(p[1]); if (lfd >= 0) close(lfd);
    printf("ok %s\n", name); fflush(stdout);
}

/* The same, with the wait on a non-main thread: the main thread blocks
 * SIGCHLD, so the process-directed signal can only go to the waiter. */
struct thread_case { int kind, nocldwait; };
static void *thread_case_main(void *a) {
    struct thread_case *t = a;
    sigset_t s; sigemptyset(&s); sigaddset(&s, SIGCHLD);
    pthread_sigmask(SIG_UNBLOCK, &s, NULL);
    run_case(t->kind, t->nocldwait, "thread-");
    return NULL;
}
static void run_thread_case(int kind, int nocldwait) {
    sigset_t s, old; sigemptyset(&s); sigaddset(&s, SIGCHLD);
    pthread_sigmask(SIG_BLOCK, &s, &old);
    struct thread_case t = {kind, nocldwait};
    pthread_t th;
    pthread_create(&th, NULL, thread_case_main, &t);
    pthread_join(th, NULL);
    pthread_sigmask(SIG_SETMASK, &old, NULL);
}

int main(void) {
    for (int k = POLL; k <= ACCEPT; k++) { run_case(k, 1, ""); run_case(k, 0, ""); }
    for (int k = POLL; k <= ACCEPT; k++) { run_thread_case(k, 1); run_thread_case(k, 0); }
    puts("PASS");
    return 0;
}
