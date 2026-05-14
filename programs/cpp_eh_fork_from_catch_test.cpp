// Validation fixture for B1 stages 1+2 (fork-from-plain-catch).
//
// Pattern: a C++ try block throws an `int`; the matching catch handler
// calls fork() *from inside the handler body*. Both parent and child
// must continue from the fork site and reach their respective branches.
//
// This is the SpiderMonkey-spike test (d) pattern, documented in
// memory:spidermonkey-spike-eh-toolchain-gap.md. Before B1, this hung
// because fork-instrument carved out functions with fork calls inside
// try_table catch-handler bodies. B1 stage 1 added per-arm scratch
// space; stage 2 added rewind dispatch + capture-block emission.
//
// Decision C1 in
// docs/plans/2026-05-13-fork-instrument-unsupported-cases-review.md is
// to land a synthetic fixture as the regression gate ahead of any
// larger consumer (the SpiderMonkey port).
//
// Expected output on PASS:
//   THROWING
//   CAUGHT: 7
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   PASS: fork-from-catch

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
            printf("PASS: fork-from-catch\n");
            return 0;
        }
        printf("FAIL: child exit status=%d\n", status);
        return 1;
    }

    // Unreachable — the throw above always lands in the catch.
    printf("FAIL: throw did not propagate\n");
    return 1;
}
