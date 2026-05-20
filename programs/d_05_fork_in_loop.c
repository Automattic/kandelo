// D-05 — switch-dispatch trampoline: fork inside `loop` body.
//
// Today this forces guard-dispatch fallback because switch-dispatch's
// nested-pattern classifier refuses to extract through a wasm `loop`
// scope. After the architectural pivot the runtime-dispatcher trampoline
// must cover this case so guard-dispatch can be deleted.
//
// Pre-refactor: works (via guard-dispatch).
// Post-refactor: must work (via trampoline) — this test should pass under
// both regimes; the only change is which dispatch scheme drives it.
//
// Expected output on PASS:
//   ITER 0
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   PASS: D-05

#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <unistd.h>
#include <sys/wait.h>

int main(void) {
    // Single iteration loop — the loop scope is the point; we don't
    // want multiple forks racing. The instrumenter sees a `loop` block
    // around the fork() call which today disables switch-dispatch.
    for (int i = 0; i < 1; i++) {
        printf("ITER %d\n", i);
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
        if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
            printf("FAIL: child status=%d\n", status);
            return 1;
        }
    }
    printf("PASS: D-05\n");
    return 0;
}
