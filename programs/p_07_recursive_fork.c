// P-07 — recursive fork: parent forks child, child forks grandchild.
//
// Coverage matrix: tests that fork-instrument's state machine
// correctly handles nested fork() calls — the unwind/rewind dance
// must work for the child process when it then becomes a parent.
//
// Expected output on PASS:
//   PARENT: pre-fork-1
//   CHILD: pre-fork-2
//   GRANDCHILD: ok
//   CHILD: child=<gpid>
//   PARENT: child=<cpid>
//   PASS: P-07

#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/wait.h>
#include <errno.h>

int main(void) {
    printf("PARENT: pre-fork-1\n");
    fflush(stdout);

    pid_t cpid = fork();
    if (cpid < 0) {
        printf("FAIL: fork-1 errno=%d\n", errno);
        return 1;
    }

    if (cpid == 0) {
        // CHILD process — fork again.
        printf("CHILD: pre-fork-2\n");
        fflush(stdout);
        pid_t gpid = fork();
        if (gpid < 0) {
            printf("FAIL: fork-2 errno=%d\n", errno);
            _exit(1);
        }
        if (gpid == 0) {
            printf("GRANDCHILD: ok\n");
            fflush(stdout);
            _exit(0);
        }
        printf("CHILD: child=%d\n", gpid);
        fflush(stdout);
        int status = 0;
        if (waitpid(gpid, &status, 0) < 0) {
            printf("FAIL: child waitpid errno=%d\n", errno);
            _exit(1);
        }
        _exit((WIFEXITED(status) && WEXITSTATUS(status) == 0) ? 0 : 1);
    }

    // PARENT process.
    printf("PARENT: child=%d\n", cpid);
    fflush(stdout);
    int status = 0;
    if (waitpid(cpid, &status, 0) < 0) {
        printf("FAIL: parent waitpid errno=%d\n", errno);
        return 1;
    }
    if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
        printf("PASS: P-07\n");
        return 0;
    }
    printf("FAIL: child status=%d\n", status);
    return 1;
}
