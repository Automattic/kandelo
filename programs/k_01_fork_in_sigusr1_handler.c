// K-01 — fork from inside a sigaction(SIGUSR1) handler.
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// The handler is registered via sigaction(); it's an address-taken
// callback function reached only via the host signal-delivery path.
// C3 in the unsupported-cases review considered a broad "instrument every
// address-taken function" rule. The final PR keeps the narrower existing
// direct + call_indirect closure; this fixture is the end-to-end regression
// gate proving signal-handler delivery remains covered.
//
// Expected output on PASS:
//   REGISTERED
//   RAISING
//   IN_HANDLER signo=10
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   POST_HANDLER
//   PASS: K-01

#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <signal.h>
#include <unistd.h>
#include <sys/wait.h>

static volatile sig_atomic_t handler_done = 0;
static volatile int last_child = -1;
static volatile int last_status = -1;

static void handler(int signo) {
    printf("IN_HANDLER signo=%d\n", signo);
    printf("PRE_FORK\n");
    fflush(stdout);
    pid_t pid = fork();
    if (pid < 0) {
        printf("FAIL: fork errno=%d\n", errno);
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
        printf("FAIL: waitpid errno=%d\n", errno);
        handler_done = 2;
        return;
    }
    last_child = pid;
    last_status = status;
    handler_done = 1;
}

int main(void) {
    struct sigaction sa;
    sa.sa_handler = handler;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = 0;
    if (sigaction(SIGUSR1, &sa, NULL) < 0) {
        printf("FAIL: sigaction errno=%d\n", errno);
        return 1;
    }
    printf("REGISTERED\n");
    printf("RAISING\n");
    fflush(stdout);

    if (raise(SIGUSR1) != 0) {
        printf("FAIL: raise errno=%d\n", errno);
        return 1;
    }

    printf("POST_HANDLER\n");
    fflush(stdout);
    if (handler_done != 1) {
        printf("FAIL: handler_done=%d\n", handler_done);
        return 1;
    }
    if (!WIFEXITED(last_status) || WEXITSTATUS(last_status) != 0) {
        printf("FAIL: child status=%d\n", last_status);
        return 1;
    }
    printf("PASS: K-01\n");
    return 0;
}
