// S-08 — throw from a callee outside the fork-path call graph,
// caught inside an instrumented try_table, fork in the catch handler
// (B2).
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Sibling of C-04. C-04 emphasises the catch-handler dispatch path;
// S-08 emphasises that the throw is the side-effect-during-rewind
// instance of B2. After eliminate-guard-dispatch the body doesn't
// re-execute so B2 disappears as a class.
//
// We use a multi-call helper to make the call graph deeper — multiple
// frames between the throw site and the catching frame — so the
// instrumenter's reach analysis is exercised.
//
// Expected output on PASS:
//   ENTER_OUTER
//   ENTER_INNER
//   THROWING
//   CAUGHT: 73
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   PASS: S-08

#include <cstdio>
#include <cstdlib>
#include <cerrno>
#include <unistd.h>
#include <sys/wait.h>

__attribute__((noinline))
static void inner(void) {
    printf("ENTER_INNER\n");
    printf("THROWING\n");
    fflush(stdout);
    throw 73;
}

__attribute__((noinline))
static void outer(void) {
    printf("ENTER_OUTER\n");
    fflush(stdout);
    inner();
}

int main(void) {
    try {
        outer();
    } catch (int e) {
        printf("CAUGHT: %d\n", e);
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
            printf("PASS: S-08\n");
            return 0;
        }
        printf("FAIL: child status=%d\n", status);
        return 1;
    }
    printf("FAIL: throw did not propagate\n");
    return 1;
}
