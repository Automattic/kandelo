/* stdin-throughput.c — Read host-supplied stdin to EOF and report MB/s.
 * The host writes a fixed buffer as this process's stdin (spawn({ stdin })).
 * Timing covers the read(0) loop only, not process startup, so the metric
 * isolates how fast host stdin reaches a reader. */
#include <stdio.h>
#include <unistd.h>
#include <sys/time.h>

static long long now_us(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (long long)tv.tv_sec * 1000000LL + tv.tv_usec;
}

int main(void) {
    static char buf[65536];
    long long total = 0;
    long long start = now_us();
    for (;;) {
        ssize_t n = read(0, buf, sizeof buf);
        if (n < 0) { perror("read"); return 1; }
        if (n == 0) break;
        total += n;
    }
    long long elapsed = now_us() - start;
    if (elapsed <= 0) elapsed = 1;
    printf("stdin_bytes=%lld\n", total);
    printf("stdin_mbps=%.2f\n", (double)total / (1024.0 * 1024.0) / ((double)elapsed / 1e6));
    return 0;
}
