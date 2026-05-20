// D-04 — switch-dispatch nested: fork inside a wasm `block` body.
//
// LLVM lowers a labeled break + early-exit pattern into a wasm `block`
// surrounding the body. The fork() call lands inside the block; the
// dispatch core must treat the block scope as a nested-pattern
// extraction site.
//
// Expected output on PASS:
//   IN_BLOCK
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   PASS: D-04

#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <unistd.h>
#include <sys/wait.h>

int main(int argc, char **argv) {
    int status = 0;
    pid_t pid = -1;

    // do { ... break ... } while(0) lowers to a wasm `block` with an
    // early `br` for the break, putting fork() inside the block scope.
    do {
        printf("IN_BLOCK\n");
        printf("PRE_FORK\n");
        fflush(stdout);
        pid = fork();
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
        if (argc > 1) break;  // forces an early `br` out of the block
    } while (0);

    if (waitpid(pid, &status, 0) < 0) {
        printf("FAIL: waitpid errno=%d\n", errno);
        return 1;
    }
    if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
        printf("PASS: D-04\n");
        return 0;
    }
    printf("FAIL: child status=%d\n", status);
    return 1;
}
