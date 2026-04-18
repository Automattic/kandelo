/* pipe-throughput.c — Measure pipe write/read throughput.
 * Writes 1MB through a pipe (parent→child via fork), prints MB/s. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/time.h>
#include <sys/wait.h>

#define TOTAL_BYTES (1024 * 1024)
#define CHUNK_SIZE  4096

static long long now_us(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (long long)tv.tv_sec * 1000000LL + tv.tv_usec;
}

int main(void) {
    int fds[2];
    if (pipe(fds) < 0) { perror("pipe"); return 1; }

    pid_t pid = fork();
    if (pid < 0) { perror("fork"); return 1; }

    if (pid == 0) {
        /* Child: read and discard */
        close(fds[1]);
        char buf[CHUNK_SIZE];
        ssize_t total = 0;
        while (total < TOTAL_BYTES) {
            ssize_t n = read(fds[0], buf, CHUNK_SIZE);
            if (n <= 0) break;
            total += n;
        }
        close(fds[0]);
        _exit(0);
    }

    /* Parent: write */
    close(fds[0]);
    char buf[CHUNK_SIZE];
    memset(buf, 'A', CHUNK_SIZE);

    long long t0 = now_us();
    ssize_t total = 0;
    while (total < TOTAL_BYTES) {
        ssize_t n = write(fds[1], buf, CHUNK_SIZE);
        if (n <= 0) break;
        total += n;
    }
    close(fds[1]);
    waitpid(pid, NULL, 0);
    long long t1 = now_us();

    double elapsed_s = (t1 - t0) / 1.0e6;
    double mbps = (total / (1024.0 * 1024.0)) / elapsed_s;
    printf("pipe_mbps=%f\n", mbps);
    return 0;
}
