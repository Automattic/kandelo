// C-02 — fork inside a C++ catch handler body (single-arm plain catch).
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Pattern: try { throw int } catch (int) { fork(); }. Both parent and
// child must continue from the fork site and reach their respective
// branches.
//
// History: this is the SpiderMonkey-spike test (d) pattern from
// memory:spidermonkey-spike-eh-toolchain-gap.md, originally landed as
// programs/cpp_eh_fork_from_catch_test.cpp. Renamed for the coverage
// matrix. B1 stages 1+2 shipped on `fierce-wire` ahead of this fixture
// but did not actually close the case end-to-end — the architectural
// pivot (eliminate guard-dispatch) is the planned fix.
//
// Expected output on PASS:
//   THROWING
//   CAUGHT: 7
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   PASS: C-02

#include <cstdio>
#include <cstdlib>
#include <cerrno>
#include <unistd.h>
#include <sys/wait.h>

int main() {
    try {
        printf("THROWING\n");
        fflush(stdout);
        throw 7;
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
            printf("PASS: C-02\n");
            return 0;
        }
        printf("FAIL: child exit status=%d\n", status);
        return 1;
    }

    // Unreachable — the throw above always lands in the catch.
    printf("FAIL: throw did not propagate\n");
    return 1;
}
