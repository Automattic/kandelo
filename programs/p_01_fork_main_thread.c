// P-01 — fork() from main thread, no other threads.
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// The simplest happy-path baseline. Should pass today and continue
// to pass after the architectural pivot.
//
// Distinct from D-01 in intent: D-01 exercises the dispatch scheme;
// P-01 exercises the process-lifecycle subsystem (PID assignment,
// child memory copy, parent waitpid). Both should remain green.
//
// Expected output on PASS:
//   PRE_FORK
//   CHILD: pid=<n> ppid=<n>
//   PARENT: child=<pid>
//   PASS: P-01

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
        printf("CHILD: pid=%d ppid=%d\n", getpid(), getppid());
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
        printf("PASS: P-01\n");
        return 0;
    }
    printf("FAIL: child status=%d\n", status);
    return 1;
}
