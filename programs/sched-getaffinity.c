#define _GNU_SOURCE

#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

enum {
    KERNEL_MASK_SIZE = 4,
    LARGE_MASK_SIZE = 65540,
};

static unsigned char large_mask[LARGE_MASK_SIZE];
static pthread_mutex_t worker_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t worker_cond = PTHREAD_COND_INITIALIZER;
static pid_t worker_tid;
static int worker_ready;
static int worker_release;
static int worker_pid_zero_result;

static int expect_error(pid_t pid, long size, void *mask, int expected,
                        const char *label) {
    errno = 0;
    long result = syscall(SYS_sched_getaffinity, pid, size, mask);
    if (result != -1 || errno != expected) {
        fprintf(stderr, "%s returned %ld errno %d (expected %d)\n",
                label, result, errno, expected);
        return -1;
    }
    return 0;
}

static int expect_unchanged(const unsigned char *mask, size_t size,
                            const char *label) {
    for (size_t i = 0; i < size; ++i) {
        if (mask[i] != 0xa5) {
            fprintf(stderr, "%s changed byte %zu to 0x%02x\n",
                    label, i, mask[i]);
            return -1;
        }
    }
    return 0;
}

static int expect_raw_mask(pid_t pid, long size, unsigned char *mask,
                           size_t storage_size, const char *label) {
    memset(mask, 0xa5, storage_size);
    errno = 0;
    long result = syscall(SYS_sched_getaffinity, pid, size, mask);
    if (result != KERNEL_MASK_SIZE) {
        fprintf(stderr, "%s returned %ld errno %d\n", label, result, errno);
        return -1;
    }
    if (mask[0] != 1 || mask[1] != 0 || mask[2] != 0 || mask[3] != 0) {
        fprintf(stderr, "%s returned mask %02x %02x %02x %02x\n",
                label, mask[0], mask[1], mask[2], mask[3]);
        return -1;
    }
    for (size_t i = KERNEL_MASK_SIZE; i < storage_size; ++i) {
        if (mask[i] != 0xa5) {
            fprintf(stderr, "%s changed raw tail byte %zu to 0x%02x\n",
                    label, i, mask[i]);
            return -1;
        }
    }
    return 0;
}

static void *affinity_worker(void *unused) {
    (void)unused;
    cpu_set_t set;
    pid_t tid = (pid_t)syscall(SYS_gettid);
    int result = expect_raw_mask(0, sizeof(set), (unsigned char *)&set,
                                 sizeof(set), "worker pid zero");

    pthread_mutex_lock(&worker_lock);
    worker_tid = tid;
    worker_pid_zero_result = result;
    worker_ready = 1;
    pthread_cond_signal(&worker_cond);
    while (!worker_release) {
        pthread_cond_wait(&worker_cond, &worker_lock);
    }
    pthread_mutex_unlock(&worker_lock);
    return NULL;
}

int main(void) {
    cpu_set_t set;
    unsigned char *bytes = (unsigned char *)&set;

    const long invalid_sizes[] = {
        0, 1, 3, 5, -1, (long)9007199254740997LL,
    };
    const char *invalid_labels[] = {
        "zero", "one", "short", "misaligned", "negative",
        "wasm64 precision",
    };
    for (size_t i = 0; i < sizeof(invalid_sizes) / sizeof(invalid_sizes[0]); ++i) {
        memset(&set, 0xa5, sizeof(set));
        if (expect_error(0, invalid_sizes[i], &set, EINVAL, invalid_labels[i]) != 0
            || expect_unchanged(bytes, sizeof(set), invalid_labels[i]) != 0) {
            return 1;
        }
    }

    if (expect_error(0, KERNEL_MASK_SIZE, NULL, EFAULT, "null mask") != 0) {
        return 2;
    }
    if (expect_error(0, KERNEL_MASK_SIZE, (void *)(uintptr_t)-4,
                     EFAULT, "invalid mask") != 0) {
        return 3;
    }
    if (expect_error(0x7fffffff, 0, NULL, EINVAL,
                     "invalid size precedence") != 0) {
        return 4;
    }

    memset(&set, 0xa5, sizeof(set));
    if (expect_error(-1, KERNEL_MASK_SIZE, &set, ESRCH, "negative pid") != 0
        || expect_unchanged(bytes, sizeof(set), "negative pid") != 0) {
        return 5;
    }
    memset(&set, 0xa5, sizeof(set));
    if (expect_error(0x7fffffff, KERNEL_MASK_SIZE, &set, ESRCH, "missing pid") != 0
        || expect_unchanged(bytes, sizeof(set), "missing pid") != 0) {
        return 6;
    }
    if (expect_error(0x7fffffff, KERNEL_MASK_SIZE, NULL,
                     ESRCH, "missing pid null mask") != 0
        || expect_error(0x7fffffff, KERNEL_MASK_SIZE,
                        (void *)(uintptr_t)-4, ESRCH,
                        "missing pid invalid mask") != 0) {
        return 7;
    }

    if (expect_raw_mask(0, 4, bytes, sizeof(set), "raw size 4") != 0) {
        return 8;
    }
    if (expect_raw_mask(getpid(), 8, bytes, sizeof(set), "raw current pid") != 0) {
        return 9;
    }
    if (expect_raw_mask(0, sizeof(set), bytes, sizeof(set), "raw cpu_set_t") != 0) {
        return 10;
    }
    if (expect_raw_mask(0, (long)-4, bytes, sizeof(set),
                        "raw unsigned max aligned") != 0) {
        return 11;
    }
    if (expect_raw_mask(0, LARGE_MASK_SIZE, large_mask, sizeof(large_mask),
                        "raw large aligned") != 0) {
        return 12;
    }

    pthread_t worker;
    if (pthread_create(&worker, NULL, affinity_worker, NULL) != 0) {
        fputs("pthread_create failed\n", stderr);
        return 13;
    }
    pthread_mutex_lock(&worker_lock);
    while (!worker_ready) {
        pthread_cond_wait(&worker_cond, &worker_lock);
    }
    pid_t live_worker_tid = worker_tid;
    int worker_result = worker_pid_zero_result;
    pthread_mutex_unlock(&worker_lock);
    if (worker_result != 0 || live_worker_tid <= 0) {
        fputs("worker pid-zero affinity failed\n", stderr);
        return 14;
    }
    if (expect_raw_mask(live_worker_tid, 8, bytes, sizeof(set),
                        "live worker tid") != 0) {
        return 15;
    }
    pthread_mutex_lock(&worker_lock);
    worker_release = 1;
    pthread_cond_signal(&worker_cond);
    pthread_mutex_unlock(&worker_lock);
    if (pthread_join(worker, NULL) != 0) {
        fputs("pthread_join failed\n", stderr);
        return 16;
    }
    memset(&set, 0xa5, sizeof(set));
    if (expect_error(live_worker_tid, KERNEL_MASK_SIZE, &set,
                     ESRCH, "dead worker tid") != 0
        || expect_unchanged(bytes, sizeof(set), "dead worker tid") != 0) {
        return 17;
    }

    memset(&set, 0xa5, sizeof(set));
    if (sched_getaffinity(0, sizeof(set), &set) != 0) {
        perror("sched_getaffinity");
        return 18;
    }
    if (!CPU_ISSET(0, &set)) {
        fputs("CPU 0 missing\n", stderr);
        return 19;
    }
    for (int cpu = 1; cpu < CPU_SETSIZE; ++cpu) {
        if (CPU_ISSET(cpu, &set)) {
            fprintf(stderr, "unexpected CPU %d\n", cpu);
            return 20;
        }
    }
    for (size_t i = 1; i < sizeof(set); ++i) {
        if (bytes[i] != 0) {
            fprintf(stderr, "libc left byte %zu as 0x%02x\n", i, bytes[i]);
            return 21;
        }
    }

    long online = sysconf(_SC_NPROCESSORS_ONLN);
    long configured = sysconf(_SC_NPROCESSORS_CONF);
    if (online != 1 || configured != 1) {
        fprintf(stderr, "unexpected CPU counts: online=%ld configured=%ld\n",
                online, configured);
        return 22;
    }

    printf("sched-getaffinity-ok raw=%d cpus=%ld\n",
           KERNEL_MASK_SIZE, online);
    return 0;
}
