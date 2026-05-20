// K-07 — fork() from an atexit-registered handler.
//
// Coverage matrix: another address-taken-fork-root pattern. The
// atexit handler is called via libc's exit() machinery during
// process termination. fork() inside it must work the same as
// any other fork-path call.
//
// Note: the parent calls fork() inside the atexit handler, gets
// the child pid, but then exit() machinery may not let it
// waitpid() (we're already in shutdown). So the test uses a
// pre-exit waitpid setup: the atexit handler doesn't waitpid,
// just records the child pid. main() waits BEFORE returning, by
// triggering atexit early via explicit exit().
//
// Expected output on PASS:
//   PRE_EXIT
//   IN_ATEXIT
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   POST_FORK_PARENT
//   PASS: K-07

#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/wait.h>
#include <errno.h>

static int g_child_pid = -1;
static int g_pass = 0;

static void atexit_handler(void) {
    printf("IN_ATEXIT\n");
    printf("PRE_FORK\n");
    fflush(stdout);

    pid_t pid = fork();
    if (pid < 0) {
        printf("FAIL: fork errno=%d\n", errno);
        return;
    }
    if (pid == 0) {
        printf("CHILD: ok\n");
        fflush(stdout);
        _exit(0);
    }
    printf("PARENT: child=%d\n", pid);
    fflush(stdout);
    g_child_pid = pid;

    // Reap child here in atexit (can't easily defer to main).
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        printf("FAIL: waitpid errno=%d\n", errno);
        return;
    }
    printf("POST_FORK_PARENT\n");
    fflush(stdout);
    if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
        printf("PASS: K-07\n");
        g_pass = 1;
    } else {
        printf("FAIL: child status=%d\n", status);
    }
    fflush(stdout);
}

int main(void) {
    if (atexit(atexit_handler) != 0) {
        printf("FAIL: atexit returned non-zero\n");
        return 1;
    }
    printf("PRE_EXIT\n");
    fflush(stdout);
    // Falls through to main return; atexit handler then runs.
    // The exit status will be 0 if main returns 0 — regardless of
    // what the atexit handler did. The PASS marker is what the
    // test asserts.
    return 0;
}
