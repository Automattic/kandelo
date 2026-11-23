/*
 * test-pthread.c — Basic pthread_create / pthread_join test.
 *
 * Verifies:
 *   1. pthread_create spawns a thread that runs
 *   2. The thread can modify shared state
 *   3. pthread_join waits for completion and retrieves the result
 *   4. pthread_getattr_np reports live stack bounds for both threads
 *   5. pthread_getschedparam and sched_get_priority_* agree on SCHED_OTHER
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdint.h>
#include <pthread.h>
#include <sched.h>

static int shared_value = 0;

static int stack_contains(uintptr_t address) {
    pthread_attr_t attr;
    void *base;
    size_t size;
    if (pthread_getattr_np(pthread_self(), &attr) != 0)
        return 0;
    int rc = pthread_attr_getstack(&attr, &base, &size);
    pthread_attr_destroy(&attr);
    if (rc != 0)
        return 0;
    uintptr_t low = (uintptr_t)base;
    return address >= low && address - low < size;
}

static int default_priority_round_trips(void) {
    int policy;
    struct sched_param param;
    pthread_t self = pthread_self();
    return pthread_getschedparam(self, &policy, &param) == 0 &&
        policy == SCHED_OTHER &&
        param.sched_priority == sched_get_priority_min(policy) &&
        param.sched_priority == sched_get_priority_max(policy) &&
        pthread_setschedprio(self, param.sched_priority) == 0;
}

static void *thread_func(void *arg) {
    int inc = *(int *)arg;
    if (!stack_contains((uintptr_t)&inc)) {
        printf("FAIL: child frame is outside reported stack bounds\n");
        return NULL;
    }
    if (!default_priority_round_trips()) {
        printf("FAIL: child SCHED_OTHER priority did not round trip\n");
        return NULL;
    }
    shared_value += inc;
    return (void *)(long)42;
}

int main(void) {
    pthread_t t;
    int arg = 10;
    void *retval = NULL;
    if (!default_priority_round_trips()) {
        printf("FAIL: main SCHED_OTHER priority did not round trip\n");
        return 1;
    }

    if (!stack_contains((uintptr_t)&arg)) {
        printf("FAIL: main frame is outside reported stack bounds\n");
        return 1;
    }

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
