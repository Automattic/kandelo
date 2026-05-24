// S-03 — __c11_atomic_compare_exchange_strong before fork() (B1
// compare-exchange class).
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Under guard-dispatch a REWIND would re-attempt the CAS — first
// attempt swapped 0→1, second attempt would see 1 (not 0) and fail,
// changing the program's observable result. Under switch-dispatch +
// trampoline the body doesn't re-execute.
//
// Expected output on PASS:
//   PRE_FORK
//   CAS swapped=1 expected=0 actual=1
//   CHILD: ok actual=1
//   PARENT: child=<pid> actual=1
//   PASS: S-03

#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <stdatomic.h>
#include <unistd.h>
#include <sys/wait.h>

static _Atomic int slot = 0;

int main(void) {
    printf("PRE_FORK\n");
    fflush(stdout);

    int expected = 0;
    int swapped = atomic_compare_exchange_strong(&slot, &expected, 1);
    printf("CAS swapped=%d expected=%d actual=%d\n",
           swapped, expected, atomic_load(&slot));
    fflush(stdout);
    if (!swapped) {
        printf("FAIL: CAS did not swap\n");
        return 1;
    }

    pid_t pid = fork();
    if (pid < 0) {
        printf("FAIL: fork errno=%d\n", errno);
        return 1;
    }
    if (pid == 0) {
        printf("CHILD: ok actual=%d\n", atomic_load(&slot));
        fflush(stdout);
        return 0;
    }
    printf("PARENT: child=%d actual=%d\n", pid, atomic_load(&slot));
    fflush(stdout);
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        printf("FAIL: waitpid errno=%d\n", errno);
        return 1;
    }
    if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
        printf("PASS: S-03\n");
        return 0;
    }
    printf("FAIL: child status=%d\n", status);
    return 1;
}
