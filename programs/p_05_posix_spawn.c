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
#include <fcntl.h>
#include <string.h>
#include <unistd.h>
#include <spawn.h>
#include <sys/stat.h>
#include <sys/wait.h>

extern char **environ;

static int prepare_echo_path(void) {
    int fd = open("/tmp/echo", O_WRONLY | O_CREAT | O_TRUNC, 0755);
    if (fd < 0) {
        printf("FAIL: create /tmp/echo errno=%d\n", errno);
        return -1;
    }
    const char placeholder[] = "placeholder\n";
    if (write(fd, placeholder, sizeof(placeholder) - 1) < 0) {
        printf("FAIL: write /tmp/echo errno=%d\n", errno);
        close(fd);
        return -1;
    }
    if (fchmod(fd, 0755) != 0) {
        printf("FAIL: chmod /tmp/echo errno=%d\n", errno);
        close(fd);
        return -1;
    }
    if (close(fd) != 0) {
        printf("FAIL: close /tmp/echo errno=%d\n", errno);
        return -1;
    }
    if (setenv("PATH", "/tmp", 1) != 0) {
        printf("FAIL: setenv PATH errno=%d\n", errno);
        return -1;
    }
    return 0;
}

int main(void) {
    if (prepare_echo_path() != 0) {
        return 1;
    }

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
