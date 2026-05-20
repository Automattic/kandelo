// P-02 — fork() while another thread is blocked in pthread_cond_wait.
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// POSIX semantics: only the calling thread continues in the child.
// The blocked thread does not exist in the child. The parent's
// blocked thread continues to wait. This exercises the kernel's
// per-thread fork copy semantics.
//
// To keep the test deterministic we signal the cond before joining
// the parent thread; the child just exits cleanly without touching
// the cond.
//
// Expected output on PASS:
//   THREAD_BLOCKED
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   THREAD_WOKE
//   PASS: P-02

#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <unistd.h>
#include <pthread.h>
#include <sys/wait.h>

static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;
static int signalled = 0;
static int blocked_seen = 0;

static void *waiter(void *arg) {
    (void)arg;
    pthread_mutex_lock(&mu);
    blocked_seen = 1;
    while (!signalled) pthread_cond_wait(&cv, &mu);
    pthread_mutex_unlock(&mu);
    return NULL;
}

int main(void) {
    pthread_t t;
    pthread_create(&t, NULL, waiter, NULL);

    // Wait until the helper is actually inside cond_wait.
    while (1) {
        pthread_mutex_lock(&mu);
        int seen = blocked_seen;
        pthread_mutex_unlock(&mu);
        if (seen) break;
        usleep(1000);
    }
    // Allow the wait to actually be entered (avoid race between
    // setting blocked_seen and reaching cond_wait).
    usleep(20000);
    printf("THREAD_BLOCKED\n");
    printf("PRE_FORK\n");
    fflush(stdout);

    pid_t pid = fork();
    if (pid < 0) {
        printf("FAIL: fork errno=%d\n", errno);
        return 1;
    }
    if (pid == 0) {
        printf("CHILD: ok\n");
        fflush(stdout);
        _exit(0);
    }
    printf("PARENT: child=%d\n", pid);
    fflush(stdout);

    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        printf("FAIL: waitpid errno=%d\n", errno);
        return 1;
    }

    pthread_mutex_lock(&mu);
    signalled = 1;
    pthread_cond_signal(&cv);
    pthread_mutex_unlock(&mu);
    pthread_join(t, NULL);
    printf("THREAD_WOKE\n");
    fflush(stdout);

    if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
        printf("PASS: P-02\n");
        return 0;
    }
    printf("FAIL: child status=%d\n", status);
    return 1;
}
