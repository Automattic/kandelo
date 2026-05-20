// D-03 — switch-dispatch nested: fork inside `if` body.
//
// The fork() call lives one level deep under an `if`. switch-dispatch's
// nested-pattern classifier must recognize this as eligible (the post-fork
// continuation can be extracted into the dispatch table).
//
// Expected output on PASS:
//   IN_IF
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   PASS: D-03

#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <unistd.h>
#include <sys/wait.h>

int main(int argc, char **argv) {
    int do_fork = (argc < 2) || (atoi(argv[1]) != 0);
    if (do_fork) {
        printf("IN_IF\n");
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
            printf("PASS: D-03\n");
            return 0;
        }
        printf("FAIL: child status=%d\n", status);
        return 1;
    }
    printf("FAIL: if branch not taken\n");
    return 1;
}
