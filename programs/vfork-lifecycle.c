/*
 * End-to-end vfork lifetime coverage.
 *
 * The child either calls execve() or _exit(), forks (an ordinary fork copies
 * the borrowed memory, as on Linux, and Qt's QProcess::startDetached relies on
 * it), or probes the ownership-creating calls that must still fail with
 * EAGAIN: a second vfork borrower and pthread_create.
 */
#include <errno.h>
#include <pthread.h>
#include <stddef.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static void marker(const char *text, size_t length) {
    while (length > 0) {
        ssize_t written = write(STDOUT_FILENO, text, length);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) _exit(120);
        text += written;
        length -= (size_t)written;
    }
}

#define MARKER(text) marker(text, sizeof(text) - 1)

static int wait_for_exit(pid_t pid, int expected) {
    int status = 0;
    if (waitpid(pid, &status, 0) != pid) return 1;
    if (!WIFEXITED(status) || WEXITSTATUS(status) != expected) return 1;
    return 0;
}

static int exit_cycle(const char *child_text, size_t child_length,
                      const char *parent_text, size_t parent_length) {
    pid_t pid = vfork();
    if (pid < 0) return 1;
    if (pid == 0) {
        marker(child_text, child_length);
        _exit(0);
    }
    marker(parent_text, parent_length);
    return wait_for_exit(pid, 0);
}

static int failed_exec_cycle(void) {
    pid_t pid = vfork();
    if (pid < 0) return 1;
    if (pid == 0) {
        char *const argv[] = { (char *)"missing-vfork-target", NULL };
        char *const envp[] = { NULL };
        execve("/bin/missing-vfork-target", argv, envp);
        if (errno != ENOENT) _exit(91);
        MARKER("CHILD_FAILED_EXEC\n");
        _exit(0);
    }
    MARKER("PARENT_AFTER_FAILED_EXEC_EXIT\n");
    return wait_for_exit(pid, 0);
}

static void *unused_thread(void *argument) {
    return argument;
}

/* may_copy: the run admits a second full address space. An ordinary fork
 * from the vfork child copies memory; under a no-copy ceiling it would fail
 * with ENOMEM, which is the truthful result there, so it is not probed. */
static int nested_ownership_cycle(int may_copy) {
    pid_t pid = vfork();
    if (pid < 0) return 1;
    if (pid == 0) {
        if (may_copy) {
            pid_t grandchild = fork();
            if (grandchild < 0) _exit(92);
            if (grandchild == 0) {
                MARKER("GRANDCHILD_OF_VFORK_CHILD\n");
                _exit(7);
            }
            if (wait_for_exit(grandchild, 7) != 0) _exit(96);
            MARKER("CHILD_REAPED_GRANDCHILD\n");
        }

        errno = 0;
        if (vfork() != -1 || errno != EAGAIN) _exit(93);
        MARKER("CHILD_NESTED_VFORK_EAGAIN\n");

        pthread_t thread;
        if (pthread_create(&thread, NULL, unused_thread, NULL) != EAGAIN) {
            _exit(94);
        }
        MARKER("CHILD_PTHREAD_EAGAIN\n");
        _exit(0);
    }
    MARKER("PARENT_AFTER_NESTED_OWNERSHIP\n");
    return wait_for_exit(pid, 0);
}

/* QProcess::startDetached's shape: the vfork child starts a new session,
 * forks a grandchild that execs, reports its pid, and exits at once. The
 * grandchild outlives the vfork child; the parent learns it finished when
 * the pipe it inherited reaches end of file. */
static int detached_cycle(void) {
    int fds[2];
    if (pipe(fds) != 0) return 1;
    pid_t pid = vfork();
    if (pid < 0) return 1;
    if (pid == 0) {
        setsid();
        pid_t grandchild = fork();
        if (grandchild < 0) _exit(97);
        if (grandchild == 0) {
            char *const argv[] = {
                (char *)"vfork-exec-child",
                (char *)"from-detached",
                NULL,
            };
            char *const envp[] = { (char *)"FROM=detached", NULL };
            execve("/bin/vfork-exec-child", argv, envp);
            _exit(98);
        }
        if (write(fds[1], &grandchild, sizeof grandchild)
                != (ssize_t)sizeof grandchild) {
            _exit(99);
        }
        _exit(0);
    }
    close(fds[1]);
    if (wait_for_exit(pid, 0) != 0) return 1;
    pid_t grandchild = 0;
    if (read(fds[0], &grandchild, sizeof grandchild)
            != (ssize_t)sizeof grandchild || grandchild <= 0) {
        return 1;
    }
    char byte;
    ssize_t n;
    while ((n = read(fds[0], &byte, 1)) < 0 && errno == EINTR) {}
    close(fds[0]);
    if (n != 0) return 1;
    MARKER("PARENT_SAW_DETACHED_GRANDCHILD_EXIT\n");
    return 0;
}

static int successful_exec_cycle(void) {
    pid_t pid = vfork();
    if (pid < 0) return 1;
    if (pid == 0) {
        char *const argv[] = {
            (char *)"vfork-exec-child",
            (char *)"from-vfork",
            NULL,
        };
        char *const envp[] = { (char *)"FROM=vfork", NULL };
        execve("/bin/vfork-exec-child", argv, envp);
        _exit(95);
    }
    // The caller resumes at the successful exec commit, not child exit.
    MARKER("PARENT_AFTER_EXEC_COMMIT\n");
    if (wait_for_exit(pid, 42) != 0) return 1;
    MARKER("PARENT_REAPED_EXEC_CHILD\n");
    return 0;
}

int main(int argc, char **argv) {
    MARKER("VFORK_LIFECYCLE_BEGIN\n");
    if (exit_cycle(
            "CHILD_EXIT_ONE\n", sizeof("CHILD_EXIT_ONE\n") - 1,
            "PARENT_RESUME_ONE\n", sizeof("PARENT_RESUME_ONE\n") - 1)) {
        return 1;
    }
    if (exit_cycle(
            "CHILD_EXIT_TWO\n", sizeof("CHILD_EXIT_TWO\n") - 1,
            "PARENT_RESUME_TWO\n", sizeof("PARENT_RESUME_TWO\n") - 1)) {
        return 2;
    }
    if (failed_exec_cycle() != 0) return 3;
    int no_copy = argc == 2 && strcmp(argv[1], "no-successful-exec") == 0;
    if (nested_ownership_cycle(!no_copy) != 0) return 4;
    if (no_copy) {
        MARKER("PARENT_SKIPPED_EXEC_UNDER_NO_COPY_CEILING\n");
        MARKER("PASS: VFORK_LIFECYCLE\n");
        return 0;
    }
    if (successful_exec_cycle() != 0) return 5;
    if (detached_cycle() != 0) return 6;
    MARKER("PASS: VFORK_LIFECYCLE\n");
    return 0;
}
