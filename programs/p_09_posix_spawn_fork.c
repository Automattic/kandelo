// P-09 — posix_spawn() forking path.
//
// Coverage matrix: P-05 already tests posix_spawn but in a way that
// might not exercise its fork-path (depending on libc/kernel
// implementation). P-09 explicitly verifies that posix_spawn
// creates a child process and that child runs to completion.
// musl's posix_spawn internally uses fork+exec, so this exercises
// the fork-instrument's UNWIND/REWIND machinery during spawn.
//
// Expected output on PASS:
//   PRE_SPAWN
//   PARENT: child=<pid>
//   PASS: P-09

#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/wait.h>
#include <spawn.h>
#include <errno.h>

extern char **environ;

int main(void) {
    printf("PRE_SPAWN\n");
    fflush(stdout);

    char *const argv[] = {(char *)"echo", (char *)"CHILD_SPAWN_OK", NULL};
    pid_t pid;
    int rc = posix_spawnp(&pid, "echo", NULL, NULL, argv, environ);
    if (rc != 0) {
        printf("FAIL: posix_spawnp errno=%d\n", rc);
        return 1;
    }
    printf("PARENT: child=%d\n", pid);
    fflush(stdout);

    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        printf("FAIL: waitpid errno=%d\n", errno);
        return 1;
    }
    if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
        printf("PASS: P-09\n");
        return 0;
    }
    printf("FAIL: child status=%d\n", status);
    return 1;
}
