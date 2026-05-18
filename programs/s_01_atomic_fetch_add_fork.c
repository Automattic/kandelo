// S-01 — __atomic_fetch_add on a shared variable before fork() (B1
// atomic RMW class).
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Under guard-dispatch the body re-runs on REWIND, which would
// duplicate the atomic RMW. The current code leaves atomic RMWs
// ungated (B1 in the unsupported-cases review) so a hit could
// double-increment. Under switch-dispatch + trampoline the body
// doesn't re-execute and B1 disappears as a class.
//
// We assert the counter is incremented exactly once by checking it
// after wait().
//
// Expected output on PASS:
//   PRE_FORK counter=0
//   POST_FORK counter=1
//   CHILD: ok counter=1
//   PARENT: child=<pid> counter=1
//   PASS: S-01

#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <unistd.h>
#include <sys/wait.h>
#include <stdatomic.h>

static _Atomic int counter = 0;

int main(void) {
    printf("PRE_FORK counter=%d\n", atomic_load(&counter));
    fflush(stdout);

    // RMW immediately before fork. If the body re-executes, the
    // counter would advance to 2 in the parent.
    atomic_fetch_add(&counter, 1);

    pid_t pid = fork();
    if (pid < 0) {
        printf("FAIL: fork errno=%d\n", errno);
        return 1;
    }
    if (pid == 0) {
        printf("CHILD: ok counter=%d\n", atomic_load(&counter));
        fflush(stdout);
        return 0;
    }
    printf("POST_FORK counter=%d\n", atomic_load(&counter));
    printf("PARENT: child=%d counter=%d\n", pid, atomic_load(&counter));
    fflush(stdout);
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        printf("FAIL: waitpid errno=%d\n", errno);
        return 1;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        printf("FAIL: child status=%d\n", status);
        return 1;
    }
    int final = atomic_load(&counter);
    if (final != 1) {
        printf("FAIL: counter=%d (expected 1)\n", final);
        return 1;
    }
    printf("PASS: S-01\n");
    return 0;
}
