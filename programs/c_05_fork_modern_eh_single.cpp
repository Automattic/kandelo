// C-05 — modern EH: single-clause typed catch, fork inside the
// handler (modern wasm-EH lowering).
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Source-level identical to C-02 but exercises modern wasm-EH lowering
// (catch_ref / try_table) once the SDK flag flip in commit 8 lands.
// Pre-flip the SDK still compiles this with legacy-EH so it
// effectively duplicates C-02 — the divergence appears once C5's
// libcxx + flag flip lands.
//
// Expected output on PASS:
//   THROWING
//   CAUGHT: 1
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   PASS: C-05

#include <cstdio>
#include <cstdlib>
#include <cerrno>
#include <unistd.h>
#include <sys/wait.h>

int main(void) {
    try {
        printf("THROWING\n");
        fflush(stdout);
        throw 1;
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
            printf("PASS: C-05\n");
            return 0;
        }
        printf("FAIL: child status=%d\n", status);
        return 1;
    }
    printf("FAIL: throw did not propagate\n");
    return 1;
}
