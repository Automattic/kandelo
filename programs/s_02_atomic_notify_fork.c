// S-02 — atomic.notify on a futex before fork() (B1 atomic notify
// class).
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Same family as S-01 but exercises the notify path specifically.
// Under guard-dispatch a REWIND replay would re-issue the notify.
// Under switch-dispatch + trampoline the body doesn't re-execute.
//
// Single-threaded test — no waiter actually waits — so we only
// assert the notify call returns without crashing and the fork
// completes correctly.
//
// Expected output on PASS:
//   PRE_FORK
//   POST_NOTIFY ret=<n>
//   CHILD: ok
//   PARENT: child=<pid>
//   PASS: S-02

#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <stdatomic.h>
#include <unistd.h>
#include <sys/wait.h>

static _Atomic int futex = 0;

int main(void) {
    printf("PRE_FORK\n");
    fflush(stdout);

    // memory.atomic.notify intrinsic. count=1 with no waiters returns 0.
    int ret = __builtin_wasm_memory_atomic_notify((int *)&futex, 1);
    printf("POST_NOTIFY ret=%d\n", ret);
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
        printf("PASS: S-02\n");
        return 0;
    }
    printf("FAIL: child status=%d\n", status);
    return 1;
}
