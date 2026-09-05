/*
 * N1-I3a Task 2/3 / N1-I3b Task 1/2: the posix_spawn PARENT side. Spawns a
 * fresh-image child process (resolved by the kernel's exec-target authority
 * against the in-kernel VFS, not a host-side program map), waits for it to
 * exit, and prints its decoded `WEXITSTATUS` so the host test can assert the
 * reaped status is correct (Task 3: `host_waitpid` parked reaping).
 *
 * N1-I3b Task 2: the target path is configurable via the `SPAWN_TEST_PATH`
 * environment variable so the same binary also drives the failure/rollback
 * matrix (missing path -> ENOENT, non-executable -> EACCES, non-wasm bytes
 * -> ENOEXEC). When `SPAWN_TEST_PATH` is set, this fixture switches to
 * "report the raw posix_spawn errno and exit" mode: it never waits for a
 * child (a failed spawn has none to wait for) and prints
 * "spawn errno=<N>\n" where <N> is `posix_spawn`'s direct return value (POSIX:
 * `posix_spawn` returns the errno directly on failure, it does not set the
 * global `errno` — see `posix_spawn.c`). With `SPAWN_TEST_PATH` unset, this
 * fixture keeps its original N1-I3a/I3b-Task-1 behavior byte-for-byte:
 * spawn "/bin/child", wait for it, and print "status=<WEXITSTATUS>\n".
 *
 * Built through the SDK like the other fixtures; see fixtures/README.md.
 */
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

int main(void) {
    const char *test_path = getenv("SPAWN_TEST_PATH");

    if (test_path != NULL) {
        pid_t pid = 0;
        char *argv[] = { (char *)test_path, (char *)0 };
        int rc = posix_spawn(&pid, test_path, NULL, NULL, argv, environ);
        char line[48];
        int n = snprintf(line, sizeof(line), "spawn errno=%d\n", rc);
        if (n > 0) {
            write(1, line, (size_t)n);
        }
        return 0;
    }

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
