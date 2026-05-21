// K-02 — fork from inside a signal(SIGALRM) handler.
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Variant of K-01 using the older signal(2) API + SIGALRM. Exercises
// callback discovery for a handler reached via host signal delivery.
//
// Expected output on PASS:
//   REGISTERED
//   ALARMED
//   IN_HANDLER signo=14
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   POST_PAUSE
//   PASS: K-02

#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <signal.h>
#include <unistd.h>
#include <sys/wait.h>

static volatile sig_atomic_t handler_done = 0;
static volatile int last_status = -1;

static void handler(int signo) {
    printf("IN_HANDLER signo=%d\n", signo);
    printf("PRE_FORK\n");
    fflush(stdout);
    pid_t pid = fork();
    if (pid < 0) {
        handler_done = 2;
        return;
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
        handler_done = 2;
        return;
    }
    last_status = status;
    handler_done = 1;
}

int main(void) {
    if (signal(SIGALRM, handler) == SIG_ERR) {
        printf("FAIL: signal errno=%d\n", errno);
        return 1;
    }
    printf("REGISTERED\n");
    fflush(stdout);

    alarm(1);
    printf("ALARMED\n");
    fflush(stdout);

    // Wait for the handler to run.
    while (handler_done == 0) {
        pause();
    }

    printf("POST_PAUSE\n");
    fflush(stdout);
    if (handler_done != 1) {
        printf("FAIL: handler_done=%d\n", handler_done);
        return 1;
    }
    if (!WIFEXITED(last_status) || WEXITSTATUS(last_status) != 0) {
        printf("FAIL: child status=%d\n", last_status);
        return 1;
    }
    printf("PASS: K-02\n");
    return 0;
}
