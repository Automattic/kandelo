/* cpu-parallel.c - measure whether N workers run concurrently.
 *
 * usage: cpu-parallel <thread|fork|info> <n> <iters> [cpu|sys]
 * Each of n workers performs the same fixed work. If workers run in
 * parallel, wall time stays near the n=1 time; if serialized, it grows ~n.
 * "cpu" work is a pure arithmetic loop (no syscalls); "sys" work issues
 * getppid() iters times (every call goes through the kernel worker).
 * See docs/measurements/2026-11-16-guest-parallelism.md. */
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static long iters;
static int sys_mode;
static volatile uint64_t sink;

static double now(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

static uint64_t work(uint64_t seed) {
    if (sys_mode) {
        uint64_t acc = 0;
        for (long i = 0; i < iters; i++) acc += (uint64_t)getppid();
        return acc;
    }
    uint64_t x = seed | 1;
    for (long i = 0; i < iters; i++) {
        x ^= x << 13; x ^= x >> 7; x ^= x << 17;
        x = x * 0x9E3779B97F4A7C15ull + (uint64_t)i;
    }
    return x;
}

static void *thread_main(void *arg) {
    sink += work((uint64_t)(uintptr_t)arg);
    return NULL;
}

int main(int argc, char **argv) {
    if (argc < 2) return 2;
    printf("sysconf_onln=%ld sysconf_conf=%ld\n",
           sysconf(_SC_NPROCESSORS_ONLN), sysconf(_SC_NPROCESSORS_CONF));
    if (strcmp(argv[1], "info") == 0) return 0;
    if (argc < 4) return 2;
    int n = atoi(argv[2]);
    iters = atol(argv[3]);
    sys_mode = argc > 4 && strcmp(argv[4], "sys") == 0;
    double t0 = now();
    if (strcmp(argv[1], "thread") == 0) {
        pthread_t tid[256];
        for (int i = 0; i < n; i++)
            if (pthread_create(&tid[i], NULL, thread_main, (void *)(uintptr_t)(i + 1)) != 0) {
                perror("pthread_create"); return 1;
            }
        for (int i = 0; i < n; i++) pthread_join(tid[i], NULL);
    } else if (strcmp(argv[1], "fork") == 0) {
        for (int i = 0; i < n; i++) {
            pid_t p = fork();
            if (p < 0) { perror("fork"); return 1; }
            if (p == 0) { sink = work(i + 1); _exit(0); }
        }
        int st;
        while (wait(&st) > 0) {}
    } else {
        return 2;
    }
    double t1 = now();
    printf("mode=%s work=%s n=%d iters=%ld wall_ms=%.1f\n", argv[1],
           sys_mode ? "sys" : "cpu", n, iters, (t1 - t0) * 1000);
    return 0;
}
