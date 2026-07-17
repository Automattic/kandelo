/* file-throughput.c — Measure regular-file I/O and advisory-lock operations.
 *
 * The lock cases deliberately exercise both index shapes used by the kernel
 * manager: many files with a few records each, and one file with many
 * separated records.  OFD locks let a second independent open description
 * probe real conflicts without adding fork/worker startup to the timings.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/time.h>

#define TOTAL_BYTES (1024 * 1024)
#define CHUNK_SIZE  4096
/* Two retained OFDs per file must fit SharedFS's 160-handle browser limit. */
#define MANY_FILE_COUNT 64
#define DENSE_RANGE_COUNT 256

#ifndef F_OFD_GETLK
#define F_OFD_GETLK 36
#endif
#ifndef F_OFD_SETLK
#define F_OFD_SETLK 37
#endif

static long long now_us(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (long long)tv.tv_sec * 1000000LL + tv.tv_usec;
}

static int set_ofd_lock(int fd, short type, off_t start) {
    struct flock lock;
    memset(&lock, 0, sizeof(lock));
    lock.l_type = type;
    lock.l_whence = SEEK_SET;
    lock.l_start = start;
    lock.l_len = 1;
    return fcntl(fd, F_OFD_SETLK, &lock);
}

static int find_ofd_conflict(int fd, off_t start) {
    struct flock lock;
    memset(&lock, 0, sizeof(lock));
    lock.l_type = F_WRLCK;
    lock.l_whence = SEEK_SET;
    lock.l_start = start;
    lock.l_len = 1;
    if (fcntl(fd, F_OFD_GETLK, &lock) < 0)
        return -1;
    if (lock.l_type == F_UNLCK) {
        errno = ENOENT;
        return -1;
    }
    return 0;
}

static double elapsed_per_operation(long long start, long long end, int operations) {
    return (double)(end - start) / (double)operations;
}

static int benchmark_many_file_locks(void) {
    int owners[MANY_FILE_COUNT];
    int probes[MANY_FILE_COUNT];
    char paths[MANY_FILE_COUNT][64];
    int records = 0;
    int i;
    long long t0;
    long long t1;

    for (i = 0; i < MANY_FILE_COUNT; i++) {
        int ranges = (i % 3) + 1;
        snprintf(paths[i], sizeof(paths[i]), "/tmp/bench_lock_file_%d", i);
        owners[i] = open(paths[i], O_RDWR | O_CREAT | O_TRUNC, 0600);
        if (owners[i] < 0) {
            perror("open many-file lock owner");
            return -1;
        }
        probes[i] = open(paths[i], O_RDWR);
        if (probes[i] < 0) {
            perror("open many-file lock probe");
            return -1;
        }
        records += ranges;
    }

    t0 = now_us();
    for (i = 0; i < MANY_FILE_COUNT; i++) {
        int range;
        for (range = 0; range < (i % 3) + 1; range++) {
            if (set_ofd_lock(owners[i], F_WRLCK, (off_t)range * 2) < 0) {
                perror("many-file lock acquire");
                return -1;
            }
        }
    }
    t1 = now_us();
    printf("lock_many_files_acquire_us_per_op=%f\n",
           elapsed_per_operation(t0, t1, records));

    t0 = now_us();
    for (i = 0; i < MANY_FILE_COUNT; i++) {
        int range;
        for (range = 0; range < (i % 3) + 1; range++) {
            if (find_ofd_conflict(probes[i], (off_t)range * 2) < 0) {
                perror("many-file conflict lookup");
                return -1;
            }
        }
    }
    t1 = now_us();
    printf("lock_many_files_conflict_us_per_op=%f\n",
           elapsed_per_operation(t0, t1, records));

    t0 = now_us();
    for (i = 0; i < MANY_FILE_COUNT; i++) {
        int range;
        for (range = 0; range < (i % 3) + 1; range++) {
            if (set_ofd_lock(owners[i], F_RDLCK, (off_t)range * 2) < 0) {
                perror("many-file lock replacement");
                return -1;
            }
        }
    }
    t1 = now_us();
    printf("lock_many_files_replace_us_per_op=%f\n",
           elapsed_per_operation(t0, t1, records));

    t0 = now_us();
    for (i = 0; i < MANY_FILE_COUNT; i++) {
        int range;
        for (range = 0; range < (i % 3) + 1; range++) {
            if (set_ofd_lock(owners[i], F_UNLCK, (off_t)range * 2) < 0) {
                perror("many-file lock release");
                return -1;
            }
        }
    }
    t1 = now_us();
    printf("lock_many_files_unlock_us_per_op=%f\n",
           elapsed_per_operation(t0, t1, records));

    for (i = 0; i < MANY_FILE_COUNT; i++) {
        close(probes[i]);
        close(owners[i]);
        unlink(paths[i]);
    }
    return 0;
}

static int benchmark_dense_file_locks(void) {
    const char *path = "/tmp/bench_lock_dense";
    int owner = open(path, O_RDWR | O_CREAT | O_TRUNC, 0600);
    int probe;
    int i;
    long long t0;
    long long t1;

    if (owner < 0) {
        perror("open dense lock owner");
        return -1;
    }
    probe = open(path, O_RDWR);
    if (probe < 0) {
        perror("open dense lock probe");
        return -1;
    }

    t0 = now_us();
    for (i = 0; i < DENSE_RANGE_COUNT; i++) {
        if (set_ofd_lock(owner, F_WRLCK, (off_t)i * 2) < 0) {
            perror("dense lock acquire");
            return -1;
        }
    }
    t1 = now_us();
    printf("lock_dense_file_acquire_us_per_op=%f\n",
           elapsed_per_operation(t0, t1, DENSE_RANGE_COUNT));

    t0 = now_us();
    for (i = 0; i < DENSE_RANGE_COUNT; i++) {
        if (find_ofd_conflict(probe, (off_t)i * 2) < 0) {
            perror("dense conflict lookup");
            return -1;
        }
    }
    t1 = now_us();
    printf("lock_dense_file_conflict_us_per_op=%f\n",
           elapsed_per_operation(t0, t1, DENSE_RANGE_COUNT));

    t0 = now_us();
    for (i = 0; i < DENSE_RANGE_COUNT; i++) {
        if (set_ofd_lock(owner, F_RDLCK, (off_t)i * 2) < 0) {
            perror("dense lock replacement");
            return -1;
        }
    }
    t1 = now_us();
    printf("lock_dense_file_replace_us_per_op=%f\n",
           elapsed_per_operation(t0, t1, DENSE_RANGE_COUNT));

    t0 = now_us();
    for (i = 0; i < DENSE_RANGE_COUNT; i++) {
        if (set_ofd_lock(owner, F_UNLCK, (off_t)i * 2) < 0) {
            perror("dense lock release");
            return -1;
        }
    }
    t1 = now_us();
    printf("lock_dense_file_unlock_us_per_op=%f\n",
           elapsed_per_operation(t0, t1, DENSE_RANGE_COUNT));

    close(probe);
    close(owner);
    unlink(path);
    return 0;
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
    if (benchmark_many_file_locks() < 0)
        return 1;
    if (benchmark_dense_file_locks() < 0)
        return 1;
    return 0;
}
