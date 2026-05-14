// D-02 — switch-dispatch: multiple top-level forks (3+) in same
// function, each reached on different conditional branches.
//
// Exercises the multi-arm switch-dispatch table the instrumenter
// emits when it sees more than one fork() call site at the top level
// of a function. After the architectural pivot the dispatch table
// must still resume at the correct site.
//
// Expected output on PASS:
//   ARM: 0   (or 1, or 2 — depending on argv[1])
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   PASS: D-02

#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <string.h>
#include <unistd.h>
#include <sys/wait.h>

static int do_fork_and_wait(int arm) {
    printf("PRE_FORK\n");
    fflush(stdout);
    pid_t pid = fork();
    if (pid < 0) {
        printf("FAIL: fork errno=%d arm=%d\n", errno, arm);
        return 1;
    }
    if (pid == 0) {
        printf("CHILD: ok\n");
        fflush(stdout);
        _exit(0);
    }
    printf("PARENT: child=%d\n", pid);
    fflush(stdout);
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        printf("FAIL: waitpid errno=%d arm=%d\n", errno, arm);
        return 1;
    }
    if (WIFEXITED(status) && WEXITSTATUS(status) == 0) return 0;
    printf("FAIL: child status=%d arm=%d\n", status, arm);
    return 1;
}

int main(int argc, char **argv) {
    int arm = (argc > 1) ? atoi(argv[1]) : 0;
    printf("ARM: %d\n", arm);
    fflush(stdout);

    // Three top-level fork sites on disjoint branches. The instrumenter
    // must treat each as a distinct switch-dispatch case.
    if (arm == 0) {
        if (do_fork_and_wait(0)) return 1;
    } else if (arm == 1) {
        if (do_fork_and_wait(1)) return 1;
    } else {
        if (do_fork_and_wait(2)) return 1;
    }

    printf("PASS: D-02\n");
    return 0;
}
