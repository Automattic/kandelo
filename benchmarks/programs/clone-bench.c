/* clone-bench.c — Measure thread creation latency via pthread_create.
 * Creates a thread that immediately exits, measures round-trip time. */
#include <stdio.h>
#include <pthread.h>
#include <sys/time.h>

static long long now_us(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (long long)tv.tv_sec * 1000000LL + tv.tv_usec;
}

static void *thread_fn(void *arg) {
    (void)arg;
    return NULL;
}

int main(void) {
    pthread_t tid;

    long long t0 = now_us();
    int err = pthread_create(&tid, NULL, thread_fn, NULL);
    if (err) { printf("pthread_create failed: %d\n", err); return 1; }
    pthread_join(tid, NULL);
    long long t1 = now_us();

    double ms = (t1 - t0) / 1000.0;
    printf("clone_ms=%f\n", ms);
    return 0;
}
