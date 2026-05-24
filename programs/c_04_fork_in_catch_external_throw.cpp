// C-04 — fork in catch handler where throw originates outside the
// fork-path call graph (B2).
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Pattern: try { throw_helper(); } catch (int) { fork(); } where
// `throw_helper` is not on the fork-path. Today guard-dispatch leaves
// throws from outside the instrumented region ungated; under
// switch-dispatch + trampoline the body doesn't re-execute so this
// must just work.
//
// Expected output on PASS:
//   CALLING_HELPER
//   IN_HELPER
//   CAUGHT: 99
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   PASS: C-04

#include <cstdio>
#include <cstdlib>
#include <cerrno>
#include <unistd.h>
#include <sys/wait.h>

// Helper is intentionally not on the fork-path call graph: it does
// nothing fork-related. The instrumenter should not gate the throw.
__attribute__((noinline))
static void throw_helper(void) {
    printf("IN_HELPER\n");
    fflush(stdout);
    throw 99;
}

int main(void) {
    try {
        printf("CALLING_HELPER\n");
        fflush(stdout);
        throw_helper();
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
            printf("PASS: C-04\n");
            return 0;
        }
        printf("FAIL: child status=%d\n", status);
        return 1;
    }
    printf("FAIL: throw did not propagate\n");
    return 1;
}
