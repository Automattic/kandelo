/*
 * Prove that vfork parks only its calling pthread.
 *
 * The vfork child cannot exit until the process main thread performs pipe I/O.
 * Suspending the whole parent process would deadlock. Resuming the calling
 * pthread early would put THREAD_CALLER_RESUMED before CHILD_THREAD_EXIT.
 */
#include <errno.h>
#include <pthread.h>
#include <stddef.h>
#include <sys/wait.h>
#include <unistd.h>

static int child_ready[2];
static int child_release[2];
static pid_t child_pid = -1;
static int thread_error;

static int write_all(int fd, const char *bytes, size_t length) {
    while (length > 0) {
        ssize_t written = write(fd, bytes, length);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) return -1;
        bytes += written;
        length -= (size_t)written;
    }
    return 0;
}

static int read_one(int fd) {
    char byte;
    for (;;) {
        ssize_t count = read(fd, &byte, 1);
        if (count == 1) return 0;
        if (count < 0 && errno == EINTR) continue;
        return -1;
    }
}

#define MARKER(text) write_all(STDOUT_FILENO, text, sizeof(text) - 1)

static void *vforking_thread(void *unused) {
    (void)unused;
    if (MARKER("THREAD_BEFORE_VFORK\n") != 0) {
        thread_error = 1;
        return NULL;
    }

    pid_t pid = vfork();
    if (pid < 0) {
        thread_error = 2;
        return NULL;
    }
    if (pid == 0) {
        if (write_all(child_ready[1], "R", 1) != 0) _exit(91);
        if (read_one(child_release[0]) != 0) _exit(92);
        if (MARKER("CHILD_THREAD_EXIT\n") != 0) _exit(93);
        _exit(0);
    }

    child_pid = pid;
    if (MARKER("THREAD_CALLER_RESUMED\n") != 0) thread_error = 3;
    return NULL;
}

int main(void) {
    if (pipe(child_ready) != 0 || pipe(child_release) != 0) return 1;

    pthread_t thread;
    if (pthread_create(&thread, NULL, vforking_thread, NULL) != 0) return 2;

    if (read_one(child_ready[0]) != 0) return 3;
    if (MARKER("MAIN_SIBLING_RAN\n") != 0) return 4;
    if (write_all(child_release[1], "X", 1) != 0) return 5;
    if (MARKER("MAIN_RELEASED_CHILD\n") != 0) return 6;

    if (pthread_join(thread, NULL) != 0 || thread_error != 0) return 7;
    if (MARKER("MAIN_JOINED_CALLER\n") != 0) return 8;
    if (child_pid <= 0) return 9;
    int status = 0;
    if (waitpid(child_pid, &status, 0) != child_pid) return 10;
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return 11;
    if (MARKER("MAIN_REAPED_CHILD\n") != 0) return 12;

    if (MARKER("PASS: VFORK_FROM_THREAD\n") != 0) return 13;
    return 0;
}
