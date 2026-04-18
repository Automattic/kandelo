/* file-throughput.c — Measure file write and read throughput.
 * Writes 1MB to a file, reads it back, prints MB/s for each. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/time.h>

#define TOTAL_BYTES (1024 * 1024)
#define CHUNK_SIZE  4096

static long long now_us(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (long long)tv.tv_sec * 1000000LL + tv.tv_usec;
}

int main(void) {
    const char *path = "/tmp/bench_file_throughput";
    char buf[CHUNK_SIZE];
    memset(buf, 'B', CHUNK_SIZE);

    /* Write */
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) { perror("open write"); return 1; }

    long long t0 = now_us();
    ssize_t total = 0;
    while (total < TOTAL_BYTES) {
        ssize_t n = write(fd, buf, CHUNK_SIZE);
        if (n <= 0) break;
        total += n;
    }
    close(fd);
    long long t1 = now_us();

    double write_s = (t1 - t0) / 1.0e6;
    double write_mbps = (total / (1024.0 * 1024.0)) / write_s;
    printf("file_write_mbps=%f\n", write_mbps);

    /* Read */
    fd = open(path, O_RDONLY);
    if (fd < 0) { perror("open read"); return 1; }

    t0 = now_us();
    total = 0;
    while (total < TOTAL_BYTES) {
        ssize_t n = read(fd, buf, CHUNK_SIZE);
        if (n <= 0) break;
        total += n;
    }
    close(fd);
    t1 = now_us();

    double read_s = (t1 - t0) / 1.0e6;
    double read_mbps = (total / (1024.0 * 1024.0)) / read_s;
    printf("file_read_mbps=%f\n", read_mbps);

    unlink(path);
    return 0;
}
