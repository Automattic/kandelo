// D-10 — cross-function: fork in callee B, caller A instruments
// correctly with post-call dispatch around `call B`.
//
// The fork-instrument tool propagates fork-path status up the call
// graph: if B contains kernel_fork, every direct caller A also sees
// post-call dispatch wrapping its `call $B` instruction. The
// trampoline scheme must preserve this propagation (and apply it
// across indirect callers too — see D-07 / D-09).
//
// Expected output on PASS:
//   IN_A
//   IN_B
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   POST_B
//   POST_A
//   PASS: D-10

#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <unistd.h>
#include <sys/wait.h>

__attribute__((noinline))
static int b_fork_helper(void) {
    printf("IN_B\n");
    printf("PRE_FORK\n");
    fflush(stdout);
    pid_t pid = fork();
    if (pid < 0) return -1;
    if (pid == 0) {
        printf("CHILD: ok\n");
        fflush(stdout);
        _exit(0);
    }
    printf("PARENT: child=%d\n", pid);
    fflush(stdout);
    int st = 0;
    if (waitpid(pid, &st, 0) < 0) return -1;
    printf("POST_B\n");
    fflush(stdout);
    return (WIFEXITED(st) && WEXITSTATUS(st) == 0) ? 0 : -1;
}

__attribute__((noinline))
static int a_caller(void) {
    printf("IN_A\n");
    fflush(stdout);
    int rc = b_fork_helper();
    printf("POST_A\n");
    fflush(stdout);
    return rc;
}

int main(void) {
    if (a_caller() != 0) {
        printf("FAIL: a_caller != 0\n");
        return 1;
    }
    printf("PASS: D-10\n");
    return 0;
}
