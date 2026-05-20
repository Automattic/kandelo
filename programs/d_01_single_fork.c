// D-01 — switch-dispatch: single top-level fork at function root.
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Today this is the simplest case the instrumenter handles via
// switch-dispatch. After the architectural pivot it must continue to
// work with byte-for-byte equivalent behavior.
//
// Expected output on PASS:
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   PASS: D-01

#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <unistd.h>
#include <sys/wait.h>

int main(void) {
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
        return 0;
    }
    printf("PARENT: child=%d\n", pid);
    fflush(stdout);
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        printf("FAIL: waitpid errno=%d\n", errno);
        return 1;
    }
    if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
        printf("PASS: D-01\n");
        return 0;
    }
    printf("FAIL: child status=%d\n", status);
    return 1;
}
