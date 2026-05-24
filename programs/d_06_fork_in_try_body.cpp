// D-06 — switch-dispatch trampoline: fork inside try_table body, no
// catch executes (parent + child both proceed past the try).
//
// LLVM lowers C++ try/catch to wasm `try_table` instructions. fork()
// inside the try body but with no throw means neither branch enters a
// catch handler. Today switch-dispatch refuses to extract through a
// try_table scope, forcing guard-dispatch. After the architectural
// pivot the trampoline must cover it.
//
// Expected output on PASS:
//   IN_TRY
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   PASS: D-06

#include <cstdio>
#include <cstdlib>
#include <cerrno>
#include <unistd.h>
#include <sys/wait.h>

int main(void) {
    pid_t pid = -1;
    int status = 0;
    try {
        printf("IN_TRY\n");
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
    } catch (...) {
        printf("FAIL: unexpected catch\n");
        return 1;
    }

    if (waitpid(pid, &status, 0) < 0) {
        printf("FAIL: waitpid errno=%d\n", errno);
        return 1;
    }
    if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
        printf("PASS: D-06\n");
        return 0;
    }
    printf("FAIL: child status=%d\n", status);
    return 1;
}
