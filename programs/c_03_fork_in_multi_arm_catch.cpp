// C-03 — fork in one of multiple plain-catch arms (B1 stage 2 multi-arm).
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Pattern: try { throw "x"; } catch (int) {...} catch (const char*) { fork(); }
// Multiple plain-catch arms branching to different labels. Today this is
// carved out by B1 stage 2 (multi-target plain-catch try_tables — A3 in
// the unsupported-cases review). After A3 lands the per-target
// capture-blocks must dispatch correctly on REWIND.
//
// Expected output on PASS:
//   THROWING
//   CAUGHT_STR: x
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   PASS: C-03

#include <cstdio>
#include <cstdlib>
#include <cerrno>
#include <unistd.h>
#include <sys/wait.h>

int main(void) {
    try {
        printf("THROWING\n");
        fflush(stdout);
        throw "x";
    } catch (int e) {
        printf("FAIL: caught int %d (expected const char*)\n", e);
        return 1;
    } catch (const char *s) {
        printf("CAUGHT_STR: %s\n", s);
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
            printf("PASS: C-03\n");
            return 0;
        }
        printf("FAIL: child status=%d\n", status);
        return 1;
    }
    printf("FAIL: throw did not propagate\n");
    return 1;
}
