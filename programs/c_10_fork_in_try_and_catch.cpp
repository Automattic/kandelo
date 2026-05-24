// C-10 — fork in both try body and catch handler in the same function.
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Pattern: try { fork(); throw 0; } catch (...) { fork(); }
// Both fork sites are in the same function; the instrumenter must emit
// two distinct switch-dispatch entries (or trampoline targets) covering
// the two paths through the function. Stresses the multi-fork dispatch
// table and the catch-handler resume machinery simultaneously.
//
// Expected output on PASS:
//   IN_TRY
//   PRE_FORK_TRY
//   CHILD_TRY: ok
//   PARENT_TRY: child=<pid>
//   THROWING
//   CAUGHT
//   PRE_FORK_CATCH
//   CHILD_CATCH: ok
//   PARENT_CATCH: child=<pid>
//   PASS: C-10

#include <cstdio>
#include <cstdlib>
#include <cerrno>
#include <unistd.h>
#include <sys/wait.h>

static int waitfor(pid_t pid, const char *tag) {
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        printf("FAIL: waitpid %s errno=%d\n", tag, errno);
        return -1;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        printf("FAIL: %s child status=%d\n", tag, status);
        return -1;
    }
    return 0;
}

int main(void) {
    try {
        printf("IN_TRY\n");
        printf("PRE_FORK_TRY\n");
        fflush(stdout);
        pid_t p1 = fork();
        if (p1 < 0) { printf("FAIL: fork1 errno=%d\n", errno); return 1; }
        if (p1 == 0) {
            printf("CHILD_TRY: ok\n");
            fflush(stdout);
            _exit(0);
        }
        printf("PARENT_TRY: child=%d\n", p1);
        fflush(stdout);
        if (waitfor(p1, "try") < 0) return 1;

        printf("THROWING\n");
        fflush(stdout);
        throw 0;
    } catch (...) {
        printf("CAUGHT\n");
        printf("PRE_FORK_CATCH\n");
        fflush(stdout);
        pid_t p2 = fork();
        if (p2 < 0) { printf("FAIL: fork2 errno=%d\n", errno); return 1; }
        if (p2 == 0) {
            printf("CHILD_CATCH: ok\n");
            fflush(stdout);
            return 0;
        }
        printf("PARENT_CATCH: child=%d\n", p2);
        fflush(stdout);
        if (waitfor(p2, "catch") < 0) return 1;
        printf("PASS: C-10\n");
        return 0;
    }
    printf("FAIL: throw did not propagate\n");
    return 1;
}
