// C-11 — fork() after a fully-popped C++ catch frame.
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Pattern: try { throw } catch (int) { ... } /* catch frame popped */
// fork(). Functionally identical to fork-with-no-EH because the catch
// frame is gone by the time fork() is called, but the spike (and the
// repro on this branch) shows the parent never returns from fork().
// The architectural pivot (eliminate guard-dispatch) is the planned
// fix.
//
// History: SpiderMonkey EH+fork spike test (b) from
// memory:spidermonkey-spike-eh-toolchain-gap.md. Originally landed as
// programs/cpp_post_catch_fork_test.cpp. Renamed for the coverage
// matrix.
//
// Expected output on PASS:
//   CAUGHT: 42
//   PRE_FORK
//   PARENT: child=<pid>
//   CHILD: ok
//   PASS: C-11

#include <cstdio>
#include <cstdlib>
#include <cerrno>
#include <unistd.h>
#include <sys/wait.h>

int main() {
    // Phase 1 — throw and catch. Catch frame is fully popped on exit.
    try {
        throw 42;
    } catch (int e) {
        printf("CAUGHT: %d\n", e);
        fflush(stdout);
    }

    // Phase 2 — fork outside any try region.
    printf("PRE_FORK\n");
    fflush(stdout);
    pid_t pid = fork();
    if (pid < 0) {
        printf("FAIL: fork errno=%d\n", errno);
        return 1;
    }
    if (pid == 0) {
        // child
        printf("CHILD: ok\n");
        fflush(stdout);
        return 0;
    }
    // parent
    printf("PARENT: child=%d\n", pid);
    fflush(stdout);
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        printf("FAIL: waitpid errno=%d\n", errno);
        return 1;
    }
    if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
        printf("PASS: C-11\n");
        return 0;
    }
    printf("FAIL: child exit status=%d\n", status);
    return 1;
}
