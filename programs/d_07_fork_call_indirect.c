// D-07 — switch-dispatch trampoline: fork reached via call_indirect.
//
// Function pointer in a vtable-style table; the call to fork() is
// reached only through the function pointer dispatch. Today this
// forces guard-dispatch (the call-graph analyser handles indirect
// calls conservatively). After the architectural pivot the trampoline
// must cover it.
//
// Expected output on PASS:
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   PASS: D-07

#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <unistd.h>
#include <sys/wait.h>

typedef int (*forker_t)(void);

static int do_fork(void) {
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
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) return -1;
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return -1;
    return 0;
}

// Indirect dispatch table. Reached via call_indirect (volatile blocks
// the optimiser from devirtualising back to a direct call).
static volatile forker_t vtable[1] = { do_fork };

int main(void) {
    forker_t fn = vtable[0];
    int rc = fn();
    if (rc != 0) {
        printf("FAIL: indirect fork rc=%d\n", rc);
        return 1;
    }
    printf("PASS: D-07\n");
    return 0;
}
