/*
 * epoll_pwait's signal mask covers the whole wait.
 *
 * foot's child reaper blocks SIGCHLD everywhere and unblocks it only inside
 * epoll_pwait, so the signal can arrive nowhere else. If the mask argument
 * is ignored, the terminal never learns its shell exited and its window
 * stays open after `exit`. Two cases: a signal that arrives while the wait
 * is parked, and one already pending when the wait starts. Both must end
 * the wait with EINTR and run the handler. Prints PASS, or FAIL lines.
 */
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <sys/epoll.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile sig_atomic_t got_chld;
static void on_chld(int signo) { (void)signo; got_chld = 1; }

static int check(const char *name, int ep, const sigset_t *wait_mask) {
    struct epoll_event out[4];
    int r = epoll_pwait(ep, out, 4, 5000, wait_mask);
    int err = r < 0 ? errno : 0;
    int ok = r == -1 && err == EINTR && got_chld;
    if (!ok)
        printf("FAIL %s: r=%d errno=%d handler=%d\n", name, r, err, (int)got_chld);
    int status = 0;
    if (waitpid(-1, &status, 0) < 0) {
        printf("FAIL %s: waitpid errno=%d\n", name, errno);
        ok = 0;
    }
    got_chld = 0;
    return ok;
}

int main(void) {
    sigset_t chld, wait_mask;
    sigemptyset(&chld);
    sigaddset(&chld, SIGCHLD);
    sigprocmask(SIG_BLOCK, &chld, &wait_mask);   /* wait_mask: SIGCHLD open */
    struct sigaction sa = {0};
    sa.sa_handler = on_chld;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGCHLD, &sa, NULL);

    int ep = epoll_create1(0), p[2];
    if (ep < 0 || pipe(p) < 0) { printf("FAIL setup errno=%d\n", errno); return 1; }
    struct epoll_event ev = {.events = EPOLLIN, .data.fd = p[0]};
    epoll_ctl(ep, EPOLL_CTL_ADD, p[0], &ev);

    int ok = 1;
    /* The child exits while the parent is parked in epoll_pwait. */
    if (fork() == 0) { usleep(300000); _exit(0); }
    ok &= check("parked", ep, &wait_mask);
    /* The child has exited (SIGCHLD pending, blocked) before the wait. */
    if (fork() == 0) _exit(0);
    usleep(300000);
    ok &= check("pending", ep, &wait_mask);

    if (ok) printf("PASS\n");
    fflush(stdout);
    return ok ? 0 : 1;
}
