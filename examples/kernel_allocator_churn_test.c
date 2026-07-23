#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static int run_pipe_churn(long count) {
    const unsigned char sent = 0x5a;

    for (long iteration = 0; iteration < count; iteration++) {
        int fds[2];
        unsigned char received = 0;
        if (pipe(fds) != 0) {
            fprintf(stderr, "pipe iteration %ld failed: %s\n", iteration, strerror(errno));
            return 10;
        }
        if (write(fds[1], &sent, sizeof(sent)) != (ssize_t)sizeof(sent)) {
            fprintf(stderr, "pipe write iteration %ld failed: %s\n", iteration, strerror(errno));
            close(fds[0]);
            close(fds[1]);
            return 11;
        }
        if (read(fds[0], &received, sizeof(received)) != (ssize_t)sizeof(received) ||
            received != sent) {
            fprintf(stderr, "pipe read iteration %ld failed: %s\n", iteration, strerror(errno));
            close(fds[0]);
            close(fds[1]);
            return 12;
        }
        if (close(fds[0]) != 0 || close(fds[1]) != 0) {
            fprintf(stderr, "pipe close iteration %ld failed: %s\n", iteration, strerror(errno));
            return 13;
        }
    }

    printf("KERNEL_ALLOCATOR_PIPE_PASS count=%ld\n", count);
    return 0;
}

static int run_fork_churn(long count) {
    for (long iteration = 0; iteration < count; iteration++) {
        pid_t child = fork();
        if (child < 0) {
            fprintf(stderr, "fork iteration %ld failed: %s\n", iteration, strerror(errno));
            return 20;
        }
        if (child == 0) {
            _exit(0);
        }

        int status = 0;
        if (waitpid(child, &status, 0) != child) {
            fprintf(stderr, "waitpid iteration %ld failed: %s\n", iteration, strerror(errno));
            return 21;
        }
        if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
            fprintf(stderr, "child iteration %ld returned status %d\n", iteration, status);
            return 22;
        }
    }

    printf("KERNEL_ALLOCATOR_FORK_PASS count=%ld\n", count);
    return 0;
}

static long parse_count(const char *text) {
    char *end = NULL;
    errno = 0;
    long count = strtol(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0' || count < 1 || count > 1000000) {
        return -1;
    }
    return count;
}

int main(int argc, char **argv) {
    if (argc != 3) {
        fprintf(stderr, "usage: %s <pipe|fork> <positive-count>\n", argv[0]);
        return 2;
    }

    long count = parse_count(argv[2]);
    if (count < 0) {
        fprintf(stderr, "invalid churn count: %s\n", argv[2]);
        return 3;
    }
    if (strcmp(argv[1], "pipe") == 0) {
        return run_pipe_churn(count);
    }
    if (strcmp(argv[1], "fork") == 0) {
        return run_fork_churn(count);
    }

    fprintf(stderr, "unknown churn mode: %s\n", argv[1]);
    return 4;
}
