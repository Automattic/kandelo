// K-04 — fork from inside a qsort comparator (address-taken function).
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Pathological callback-discovery case: the comparator is passed to
// qsort as a function pointer and conditionally fork()s on the first
// comparison, then sorts normally.
//
// Forking inside a comparator is a horrible idea in real code; this
// is purely a regression gate for callback fork-path discovery.
//
// Expected output on PASS:
//   PRE_QSORT
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   POST_QSORT sorted=1
//   PASS: K-04

#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <string.h>
#include <unistd.h>
#include <sys/wait.h>

static int forked_once = 0;
static int last_status = -1;

static int compare(const void *a, const void *b) {
    if (!forked_once) {
        forked_once = 1;
        printf("PRE_FORK\n");
        fflush(stdout);
        pid_t pid = fork();
        if (pid < 0) return *(const int *)a - *(const int *)b;
        if (pid == 0) {
            printf("CHILD: ok\n");
            fflush(stdout);
            _exit(0);
        }
        printf("PARENT: child=%d\n", pid);
        fflush(stdout);
        int status = 0;
        waitpid(pid, &status, 0);
        last_status = status;
    }
    return *(const int *)a - *(const int *)b;
}

int main(void) {
    int arr[] = { 5, 3, 1, 4, 2 };
    printf("PRE_QSORT\n");
    fflush(stdout);
    qsort(arr, 5, sizeof(int), compare);

    int sorted = 1;
    for (int i = 1; i < 5; i++) {
        if (arr[i] < arr[i-1]) { sorted = 0; break; }
    }
    printf("POST_QSORT sorted=%d\n", sorted);
    fflush(stdout);
    if (!sorted) {
        printf("FAIL: not sorted\n");
        return 1;
    }
    if (!forked_once) {
        printf("FAIL: never forked\n");
        return 1;
    }
    if (!WIFEXITED(last_status) || WEXITSTATUS(last_status) != 0) {
        printf("FAIL: child status=%d\n", last_status);
        return 1;
    }
    printf("PASS: K-04\n");
    return 0;
}
