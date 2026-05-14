// Test (b) from the SpiderMonkey EH+fork spike (memory:
// spidermonkey-spike-eh-toolchain-gap.md). Documented hang pattern:
// throw → catch → catch frame fully popped → fork() outside any try
// region → fork hangs.
//
// Functionally this should be identical to a fork-with-no-EH because
// the catch frame is gone by the time fork() is called. The hang
// suggests fork-instrument or libunwind leaves state behind that
// confuses the fork path. This regression test verifies the hang
// does NOT occur on current `fierce-wire` (post-rebase, after the
// architectural Path-A switch-dispatch work in Phase 7 and the B1
// stages 1+2 work). If the test hangs, root-cause work follows.
//
// Expected output on PASS:
//   CAUGHT: 42
//   PRE_FORK
//   PARENT: child=<pid>
//   CHILD: ok
//   PASS: post-catch fork

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
        printf("PASS: post-catch fork\n");
        return 0;
    }
    printf("FAIL: child exit status=%d\n", status);
    return 1;
}
