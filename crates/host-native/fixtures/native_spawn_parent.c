/*
 * N1-I3a Task 2/3 / N1-I3b Task 1: the posix_spawn PARENT side. Spawns a
 * fresh-image child process at the ABSOLUTE VFS path "/bin/child" (resolved
 * by the kernel's exec-target authority against the in-kernel VFS, not a
 * host-side program map), waits for it to exit, and prints its decoded
 * `WEXITSTATUS` so the host test can assert the reaped status is correct
 * (Task 3: `host_waitpid` parked reaping).
 *
 * Built through the SDK like the other fixtures; see fixtures/README.md.
 */
#include <spawn.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

int main(void) {
    pid_t pid = 0;
    char *argv[] = { "/bin/child", (char *)0 };
    int rc = posix_spawn(&pid, "/bin/child", NULL, NULL, argv, environ);
    if (rc != 0) {
        return 1;
    }
    if (pid <= 0) {
        return 2;
    }

    int status = 0;
    pid_t reaped = waitpid(pid, &status, 0);
    if (reaped != pid) {
        return 3;
    }
    if (!WIFEXITED(status)) {
        return 4;
    }

    char line[32];
    int n = snprintf(line, sizeof(line), "status=%d\n", WEXITSTATUS(status));
    if (n > 0) {
        write(1, line, (size_t)n);
    }
    return 0;
}
