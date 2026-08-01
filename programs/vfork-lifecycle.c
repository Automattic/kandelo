/*
 * End-to-end vfork lifetime coverage.
 *
 * The child stays within Kandelo's supported pre-exec boundary: it either
 * calls execve(), _exit(), or probes ownership-creating calls that must fail
 * with EAGAIN before they can change parent-owned continuation state.
 */
#include <errno.h>
#include <pthread.h>
#include <stddef.h>
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

static int rejected_ownership_cycle(void) {
    pid_t pid = vfork();
    if (pid < 0) return 1;
    if (pid == 0) {
        errno = 0;
        if (fork() != -1 || errno != EAGAIN) _exit(92);
        MARKER("CHILD_NESTED_FORK_EAGAIN\n");

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
    MARKER("PARENT_AFTER_REJECTED_OWNERSHIP\n");
    return wait_for_exit(pid, 0);
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

int main(void) {
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
    if (rejected_ownership_cycle() != 0) return 4;
    if (successful_exec_cycle() != 0) return 5;
    MARKER("PASS: VFORK_LIFECYCLE\n");
    return 0;
}
