#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define THREADS 4
#define ITERATIONS 512

static unsigned long long read_u64_arg(int tag, ...) {
    __builtin_va_list ap;
    __builtin_va_start(ap, tag);
    unsigned long long value = __builtin_va_arg(ap, unsigned long long);
    __builtin_va_end(ap);
    return value;
}

static void *worker(void *arg) {
    uintptr_t thread_index = (uintptr_t)arg;
    int bad = 0;

    for (unsigned i = 0; i < ITERATIONS; i++) {
        unsigned long long expected =
            0x1234567800000000ULL + ((unsigned long long)thread_index << 20) + i;
        unsigned long long got = read_u64_arg(1, expected);
        if (got != expected) {
            fprintf(stderr, "bad va_arg thread=%lu iter=%u got=%llx expected=%llx\n",
                    (unsigned long)thread_index, i, got, expected);
            bad++;
            break;
        }

        char buf[48];
        memset(buf, 0x5a, sizeof(buf));
        int n = snprintf(buf, sizeof(buf), "etilqs_%016llx%c", expected, 0);
        char want[32];
        snprintf(want, sizeof(want), "etilqs_%016llx", expected);

        if (n != 24 || memcmp(buf, want, 23) != 0 || buf[23] != 0 || buf[24] != 0 || buf[25] != 0x5a) {
            fprintf(stderr,
                    "bad snprintf thread=%lu iter=%u n=%d buf23=%02x buf24=%02x buf25=%02x prefix=%.*s\n",
                    (unsigned long)thread_index, i, n,
                    (unsigned char)buf[23], (unsigned char)buf[24], (unsigned char)buf[25],
                    23, buf);
            bad++;
            break;
        }
    }

    return (void *)(uintptr_t)bad;
}

int main(void) {
    pthread_t threads[THREADS];
    int failures = 0;

    for (uintptr_t i = 0; i < THREADS; i++) {
        if (pthread_create(&threads[i], NULL, worker, (void *)i) != 0) {
            fprintf(stderr, "pthread_create failed for thread %lu\n", (unsigned long)i);
            return 2;
        }
    }

    for (int i = 0; i < THREADS; i++) {
        void *result = NULL;
        if (pthread_join(threads[i], &result) != 0) {
            fprintf(stderr, "pthread_join failed for thread %d\n", i);
            return 3;
        }
        failures += (int)(uintptr_t)result;
    }

    if (failures != 0) {
        fprintf(stderr, "pthread varargs stack failures=%d\n", failures);
        return 1;
    }

    puts("pthread varargs stack ok");
    return 0;
}
