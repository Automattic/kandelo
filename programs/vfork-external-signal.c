/*
 * A fatal signal delivered while a vfork child is computing cannot use the
 * child's syscall channel as an exact quiescence fence.
 *
 * The child deliberately enters a no-syscall loop after publishing its PID to
 * a sibling parent pthread. The sibling sends SIGKILL. Kandelo must contain
 * the complete shared address space instead of resuming the parked caller
 * after a forced Worker termination whose completion is not an exact fence.
 */
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stddef.h>
#include <unistd.h>

static int child_ready[2];
static int killer_started[2];
static volatile unsigned compute_sink;

static void write_all(int fd, const void *buffer, size_t length) {
    const char *bytes = buffer;
    while (length > 0) {
        ssize_t written = write(fd, bytes, length);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) _exit(120);
        bytes += written;
        length -= (size_t)written;
    }
}

static void read_all(int fd, void *buffer, size_t length) {
    char *bytes = buffer;
    while (length > 0) {
        ssize_t count = read(fd, bytes, length);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) _exit(121);
        bytes += count;
        length -= (size_t)count;
    }
}

#define MARKER(text) write_all(STDOUT_FILENO, text, sizeof(text) - 1)

static void *kill_compute_borrower(void *argument) {
    (void)argument;
    write_all(killer_started[1], "R", 1);
    pid_t pid;
    read_all(child_ready[0], &pid, sizeof(pid));

    if (kill(pid, SIGKILL) != 0) _exit(91);
    MARKER("KILLER_SENT_SIGKILL\n");

    // The host should terminate this sibling while containing the parent.
    for (;;) pause();
}

int main(void) {
    MARKER("VFORK_EXTERNAL_SIGNAL_BEGIN\n");

    if (pipe(child_ready) != 0 || pipe(killer_started) != 0) return 1;
    pthread_t killer;
    if (pthread_create(&killer, NULL, kill_compute_borrower, NULL) != 0) {
        return 2;
    }
    char ready;
    read_all(killer_started[0], &ready, 1);
    MARKER("KILLER_THREAD_READY\n");

    pid_t pid = vfork();
    if (pid < 0) return 3;
    if (pid == 0) {
        pid_t self = getpid();
        MARKER("CHILD_COMPUTE_LOOP\n");
        write_all(child_ready[1], &self, sizeof(self));

        // No syscall boundary follows this point. Forced Worker termination
        // alone must not authorize the parent to touch the shared bytes.
        for (;;) compute_sink++;
    }

    MARKER("UNSAFE_PARENT_RESUMED\n");
    return 4;
}
