/*
 * test-pthread.c — Basic pthread_create / pthread_join test.
 *
 * Verifies:
 *   1. pthread_create spawns a thread that runs
 *   2. The thread can modify shared state
 *   3. pthread_join waits for completion and retrieves the result
 */
#include <stdio.h>
#include <pthread.h>
#include <stdint.h>
#include <stdarg.h>
#include <string.h>

static int shared_value = 0;
static uint64_t thread_vararg_u64 = 0;
static int thread_vararg_char = -1;
static size_t thread_snprintf_len = 0;
static unsigned char thread_snprintf_suffix = 0xff;
static unsigned char thread_snprintf_next = 0xff;

static void read_thread_varargs(uint64_t *out_u64, int *out_char, int marker, ...) {
    (void)marker;
    va_list ap;
    va_start(ap, marker);
    *out_u64 = va_arg(ap, uint64_t);
    *out_char = va_arg(ap, int);
    va_end(ap);
}

static void *thread_func(void *arg) {
    int inc = *(int *)arg;
    char buf[64];
    int suffix;

    shared_value += inc;

    read_thread_varargs(
        &thread_vararg_u64,
        &thread_vararg_char,
        123,
        0x6a35aa9800000000ULL,
        0
    );

    memset(buf, 0x5a, sizeof(buf));
    snprintf(buf, sizeof(buf), "%s/etilqs_%llx%c", "/tmp", 0x6a35aa9800000000ULL, 0);
    suffix = (int)strlen("/tmp/etilqs_") + 16;
    thread_snprintf_len = strlen(buf);
    thread_snprintf_suffix = (unsigned char)buf[suffix];
    thread_snprintf_next = (unsigned char)buf[suffix + 1];

    return (void *)(long)42;
}

int main(void) {
    pthread_t t;
    int arg = 10;
    void *retval = NULL;

    printf("main: creating thread\n");
    int rc = pthread_create(&t, NULL, thread_func, &arg);
    if (rc != 0) {
        printf("FAIL: pthread_create returned %d\n", rc);
        return 1;
    }

    printf("main: joining thread\n");
    rc = pthread_join(t, &retval);
    if (rc != 0) {
        printf("FAIL: pthread_join returned %d\n", rc);
        return 1;
    }

    printf("main: shared_value = %d (expected 10)\n", shared_value);
    printf("main: retval = %ld (expected 42)\n", (long)retval);
    printf("main: thread vararg = 0x%llx char=%d\n",
           (unsigned long long)thread_vararg_u64, thread_vararg_char);
    printf("main: thread snprintf len=%zu suffix=%02x next=%02x\n",
           thread_snprintf_len, thread_snprintf_suffix, thread_snprintf_next);

    if (
        shared_value == 10 &&
        (long)retval == 42 &&
        thread_vararg_u64 == 0x6a35aa9800000000ULL &&
        thread_vararg_char == 0 &&
        thread_snprintf_len == strlen("/tmp/etilqs_6a35aa9800000000") &&
        thread_snprintf_suffix == 0 &&
        thread_snprintf_next == 0
    ) {
        printf("PASS\n");
        return 0;
    }

    printf("FAIL\n");
    return 1;
}
