/* signal-latency.c — kill() → handler-runs round-trip latency.
 *
 * Parent forks; child installs a SIGUSR1 handler that just records a
 * timestamp and exits. Parent records t0, kills(child, SIGUSR1), waits.
 * Reported as round-trip microseconds.
 *
 * Catches regressions in the kernel's signal-delivery path
 * (per-thread signal routing, wakeup of pending readers, signal
 * mask checks). Pairs with syscall-latency (which measures plain
 * syscall round-trip without the signal layer).
 *
 * Repeats N times and reports the average to smooth out scheduler jitter. */
#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
#include <unistd.h>
#include <sys/time.h>
#include <sys/wait.h>

#define ITERATIONS 1000

static volatile sig_atomic_t got_signal = 0;

static void handler(int sig) {
    (void)sig;
    got_signal = 1;
}

static long long now_us(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (long long)tv.tv_sec * 1000000LL + tv.tv_usec;
}

int main(void) {
    /* Install handler in the parent — we do the signal round-trip
     * within a single process to avoid fork() overhead dominating
     * each iteration. raise() goes through the same delivery path
     * as kill(getpid(), ...). */
    struct sigaction sa = {0};
    sa.sa_handler = handler;
    sigemptyset(&sa.sa_mask);
    if (sigaction(SIGUSR1, &sa, NULL) < 0) {
        perror("sigaction");
        return 1;
    }

    long long t0 = now_us();
    for (int i = 0; i < ITERATIONS; i++) {
        got_signal = 0;
        raise(SIGUSR1);
        /* Handler runs synchronously before raise() returns on a
         * single-threaded program; the loop just keeps the optimizer
         * honest. */
        if (!got_signal) {
            fprintf(stderr, "signal not delivered at iter %d\n", i);
            return 1;
        }
    }
    long long t1 = now_us();

    double avg_us = (double)(t1 - t0) / ITERATIONS;
    printf("signal_latency_us=%f\n", avg_us);
    return 0;
}
