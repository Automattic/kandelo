// C-07 — modern EH try_table with multi-arm plain catches branching
// to different labels, fork in one (A3).
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Variant of C-03 under modern-EH lowering. C-03 uses legacy-EH
// (which lowers to a sequence of __cxa_throw + landingpads); C-07
// will exercise the modern try_table multi-arm pattern after the C5
// SDK flip. A3's per-target capture-blocks must dispatch correctly
// on REWIND.
//
// Expected output on PASS:
//   THROWING
//   CAUGHT_LONG: 1234567
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   PASS: C-07

#include <cstdio>
#include <cstdlib>
#include <cerrno>
#include <unistd.h>
#include <sys/wait.h>

int main(void) {
    try {
        printf("THROWING\n");
        fflush(stdout);
        throw 1234567L;
    } catch (int e) {
        printf("FAIL: caught int %d\n", e);
        return 1;
    } catch (long e) {
        printf("CAUGHT_LONG: %ld\n", e);
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
            printf("PASS: C-07\n");
            return 0;
        }
        printf("FAIL: child status=%d\n", status);
        return 1;
    } catch (...) {
        printf("FAIL: caught via catch-all\n");
        return 1;
    }
    printf("FAIL: throw did not propagate\n");
    return 1;
}
