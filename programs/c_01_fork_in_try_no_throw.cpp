// C-01 — try { fork(); } catch (int) { ... } where no throw occurs.
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// fork() inside the try body but no throw → catch handler never runs;
// both parent and child must proceed past the try region.
//
// Functionally similar to D-06 but worth a separate test: D-06 uses a
// catch-all `catch (...)`; C-01 uses a typed `catch (int)`. The
// instrumenter sees a different try_table pattern (typed catch clause
// vs catch_all) so the rewriter exercises a different code path.
//
// Expected output on PASS:
//   IN_TRY
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   PASS: C-01

#include <cstdio>
#include <cstdlib>
#include <cerrno>
#include <unistd.h>
#include <sys/wait.h>

int main(void) {
    pid_t pid = -1;
    int status = 0;
    try {
        printf("IN_TRY\n");
        printf("PRE_FORK\n");
        fflush(stdout);
        pid = fork();
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
    } catch (int e) {
        printf("FAIL: unexpected catch %d\n", e);
        return 1;
    }

    if (waitpid(pid, &status, 0) < 0) {
        printf("FAIL: waitpid errno=%d\n", errno);
        return 1;
    }
    if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
        printf("PASS: C-01\n");
        return 0;
    }
    printf("FAIL: child status=%d\n", status);
    return 1;
}
