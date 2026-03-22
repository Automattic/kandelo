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

static int shared_value = 0;

static void *thread_func(void *arg) {
    int inc = *(int *)arg;
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
