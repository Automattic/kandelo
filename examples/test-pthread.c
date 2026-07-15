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
#include <string.h>

static int shared_value = 0;

static int check_stack_alignment(void) {
    __attribute__((aligned(16))) volatile unsigned char aligned_local[16];
    uintptr_t addr = (uintptr_t)aligned_local;
    if ((addr & 15) != 0) {
        printf("FAIL: pthread worker stack local is not 16-byte aligned: 0x%lx\n", (unsigned long)addr);
        return 1;
    }
    return 0;
}

static int check_varargs_alignment(void) {
    static const char expected[] = "8f0fcead00000000";
    char buf[64];
    memset(buf, 0xcc, sizeof(buf));

    int n = snprintf(buf, sizeof(buf), "%llx%c", 0x8f0fcead00000000ULL, 0);
    if (n != (int)strlen(expected) + 1 ||
        memcmp(buf, expected, strlen(expected)) != 0 ||
        buf[strlen(expected)] != '\0' ||
        buf[strlen(expected) + 1] != '\0') {
        printf("FAIL: pthread worker varargs formatting produced malformed bytes\n");
        printf("worker snprintf count = %d\n", n);
        printf("worker formatted prefix = %s\n", buf);
        return 1;
    }

    return 0;
}

static void *thread_func(void *arg) {
    int inc = *(int *)arg;
    if (check_stack_alignment() != 0 || check_varargs_alignment() != 0) {
        return (void *)(long)1;
    }
    shared_value += inc;
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

    if (shared_value == 10 && (long)retval == 42) {
        printf("PASS\n");
        return 0;
    }

    printf("FAIL\n");
    return 1;
}
