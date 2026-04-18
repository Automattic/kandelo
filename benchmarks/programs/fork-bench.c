/* fork-bench.c — Measure fork + child exit latency.
 * Forks a child that immediately exits, measures round-trip time. */
#include <stdio.h>
#include <unistd.h>
#include <sys/time.h>
#include <sys/wait.h>

static long long now_us(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (long long)tv.tv_sec * 1000000LL + tv.tv_usec;
}

int main(void) {
    long long t0 = now_us();

    pid_t pid = fork();
    if (pid < 0) { perror("fork"); return 1; }
    if (pid == 0) {
        _exit(0);
    }

    waitpid(pid, NULL, 0);
    long long t1 = now_us();

    double ms = (t1 - t0) / 1000.0;
    printf("fork_ms=%f\n", ms);
    return 0;
}
