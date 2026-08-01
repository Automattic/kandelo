/*
 * End-to-end fatal vfork child coverage.
 *
 * A child trap and an uncatchable signal must both terminate the borrowing
 * Worker, release only after an exact ownership fence, wake the parked parent
 * caller, and remain waitable with the truthful signal status.
 */
#include <errno.h>
#include <signal.h>
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

static int wait_for_signal(pid_t pid, int expected_signal) {
    int status = 0;
    if (waitpid(pid, &status, 0) != pid) return 1;
    if (!WIFSIGNALED(status) || WTERMSIG(status) != expected_signal) return 1;
    return 0;
}

static int trap_cycle(void) {
    pid_t pid = vfork();
    if (pid < 0) return 1;
    if (pid == 0) {
        MARKER("CHILD_BEFORE_TRAP\n");
        __builtin_trap();
        _exit(91);
    }
    MARKER("PARENT_AFTER_TRAP\n");
    if (wait_for_signal(pid, SIGILL) != 0) return 1;
    MARKER("PARENT_REAPED_TRAP\n");
    return 0;
}

static int signal_cycle(void) {
    pid_t pid = vfork();
    if (pid < 0) return 1;
    if (pid == 0) {
        MARKER("CHILD_BEFORE_SIGKILL\n");
        if (kill(getpid(), SIGKILL) != 0) _exit(92);
        _exit(93);
    }
    MARKER("PARENT_AFTER_SIGKILL\n");
    if (wait_for_signal(pid, SIGKILL) != 0) return 1;
    MARKER("PARENT_REAPED_SIGKILL\n");
    return 0;
}

int main(void) {
    MARKER("VFORK_FATAL_BEGIN\n");
    if (trap_cycle() != 0) return 1;
    if (signal_cycle() != 0) return 2;
    MARKER("PASS: VFORK_FATAL_LIFECYCLE\n");
    return 0;
}
