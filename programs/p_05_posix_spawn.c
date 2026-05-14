// P-05 — posix_spawn() (verifies the non-forking path is unchanged
// by the dispatch refactor).
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// posix_spawn does NOT use kernel_fork on our kernel — it uses a
// dedicated SYS_SPAWN syscall. So fork-instrument's call-graph
// analyser should not flag it as a fork-path root. This test is a
// regression gate that the refactor doesn't accidentally start
// instrumenting non-forking spawn paths.
//
// Expected output on PASS:
//   SPAWNED child=<pid>
//   WAIT: status=0
//   PASS: P-05

#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <string.h>
#include <unistd.h>
#include <spawn.h>
#include <sys/wait.h>

extern char **environ;

int main(void) {
    pid_t pid = -1;
    char *argv[] = { (char *)"echo", (char *)"posix-spawn-ok", NULL };

    int rc = posix_spawnp(&pid, "echo", NULL, NULL, argv, environ);
    if (rc != 0) {
        printf("FAIL: posix_spawnp rc=%d errno=%d\n", rc, errno);
        return 1;
    }
    printf("SPAWNED child=%d\n", pid);
    fflush(stdout);

    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        printf("FAIL: waitpid errno=%d\n", errno);
        return 1;
    }
    printf("WAIT: status=%d\n", status);
    fflush(stdout);

    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        printf("FAIL: spawn child status=%d\n", status);
        return 1;
    }
    printf("PASS: P-05\n");
    return 0;
}
