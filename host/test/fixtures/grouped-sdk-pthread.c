#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#define CHECK(e) do { if (!(e)) { fprintf(stderr, "FAIL line=%d errno=%d: %s\n", __LINE__, errno, #e); _Exit(1); } } while (0)
static __thread int tls_value = 13;
static volatile int initialized;
static _Atomic int total;
static pthread_barrier_t barrier;
static pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
static _Atomic int native_word32;
static _Alignas(8) _Atomic long long native_word64;
__attribute__((constructor)) static void initialize(void) { initialized++; }

static void *run(void *argument) {
    intptr_t id = (intptr_t)argument;
    CHECK(initialized == 1 && tls_value == 13);
    tls_value = 100 + id;
    if (id == 1) CHECK(__builtin_wasm_memory_atomic_wait32((int *)&native_word32, 0, 1000000) == 2);
    if (id == 2) CHECK(__builtin_wasm_memory_atomic_wait64((long long *)&native_word64, 0, 1000000) == 2);
    errno = 40 + id;
    volatile unsigned char *heap = malloc(2 * 1024 * 1024);
    CHECK(heap);
    heap[0] = id; heap[2 * 1024 * 1024 - 1] = 70 + id;
    int result = pthread_barrier_wait(&barrier);
    CHECK(result == 0 || result == PTHREAD_BARRIER_SERIAL_THREAD);
    CHECK(tls_value == 100 + id && errno == 40 + id);
    CHECK(heap[0] == id && heap[2 * 1024 * 1024 - 1] == 70 + id);
    CHECK(pthread_mutex_lock(&mutex) == 0);
    atomic_fetch_add(&total, id);
    CHECK(pthread_mutex_unlock(&mutex) == 0);
    free((void *)heap);
    return (void *)(id + 20);
}

static void *quick(void *argument) {
    CHECK(initialized == 1 && tls_value == 13);
    return argument;
}

int main(void) {
    CHECK(initialized == 1 && tls_value == 13);
    tls_value = 71;
    pthread_t threads[3];
    CHECK(pthread_barrier_init(&barrier, NULL, 4) == 0);
    for (intptr_t i = 0; i < 3; i++) CHECK(pthread_create(&threads[i], NULL, run, (void *)(i + 1)) == 0);
    int result = pthread_barrier_wait(&barrier);
    CHECK(result == 0 || result == PTHREAD_BARRIER_SERIAL_THREAD);
    for (intptr_t i = 0; i < 3; i++) {
        void *value = NULL;
        CHECK(pthread_join(threads[i], &value) == 0);
        CHECK((intptr_t)value == i + 21);
    }
    CHECK(initialized == 1 && tls_value == 71 && atomic_load(&total) == 6);
    for (intptr_t i = 0; i < 3; i++) {
        pthread_t next;
        void *value = NULL;
        CHECK(pthread_create(&next, NULL, quick, (void *)(i + 31)) == 0);
        CHECK(pthread_join(next, &value) == 0);
        CHECK((intptr_t)value == i + 31);
    }
    CHECK(pthread_barrier_destroy(&barrier) == 0);
    CHECK(pthread_mutex_destroy(&mutex) == 0);
    puts("grouped-sdk-pthread PASS tls-init-growth-wait32-wait64-join");
    return 0;
}
