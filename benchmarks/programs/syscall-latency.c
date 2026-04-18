/* syscall-latency.c — Measure average getpid() round-trip latency.
 * Calls getpid() 1000 times and prints average latency in microseconds. */
#include <stdio.h>
#include <unistd.h>
#include <sys/time.h>

#define ITERATIONS 1000

static long long now_us(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (long long)tv.tv_sec * 1000000LL + tv.tv_usec;
}

int main(void) {
    /* Warm up */
    for (int i = 0; i < 10; i++) {
        getpid();
    }

    long long t0 = now_us();
    for (int i = 0; i < ITERATIONS; i++) {
        getpid();
    }
    long long t1 = now_us();

    double avg_us = (double)(t1 - t0) / ITERATIONS;
    printf("syscall_latency_us=%f\n", avg_us);
    return 0;
}
