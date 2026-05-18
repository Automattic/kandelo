// C-06 — modern EH multi-target *_ref try_table: multiple catch_ref
// clauses to different labels, fork in one (A2).
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Multi-target catch_ref try_tables are skipped at the 6d rewrite
// stage today (A2 in the unsupported-cases review). The C++ source
// here is plain — the relevant lowering shape only appears once C5
// flips the SDK to modern-EH. Then A2's fix (per-clause dispatch
// tables in 6d_rewrite) makes this work.
//
// Expected output on PASS:
//   THROWING
//   CAUGHT_DOUBLE: 3.14
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   PASS: C-06

#include <cstdio>
#include <cstdlib>
#include <cerrno>
#include <unistd.h>
#include <sys/wait.h>

int main(void) {
    try {
        printf("THROWING\n");
        fflush(stdout);
        throw 3.14;
    } catch (int e) {
        printf("FAIL: caught int %d\n", e);
        return 1;
    } catch (long e) {
        printf("FAIL: caught long %ld\n", e);
        return 1;
    } catch (double e) {
        printf("CAUGHT_DOUBLE: %.2f\n", e);
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
            printf("PASS: C-06\n");
            return 0;
        }
        printf("FAIL: child status=%d\n", status);
        return 1;
    }
    printf("FAIL: throw did not propagate\n");
    return 1;
}
