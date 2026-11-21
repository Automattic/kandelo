#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#define CHECK(e) do { if (!(e)) { fprintf(stderr,"FAIL line=%d errno=%d: %s\n",__LINE__,errno,#e); _Exit(1); } } while(0)
static __thread int tls_value = 13;
static volatile int initialized;
static int word;
__attribute__((constructor)) static void initialize(void) { initialized++; }
static void *run(void *argument) {
    intptr_t id = (intptr_t)argument;
    volatile unsigned char stack[8192];
    CHECK(initialized == 1 && tls_value == 13);
    tls_value = 100 + id;
    errno = 40 + id % 11;
    stack[0] = id; stack[8191] = id + 17;
    CHECK(__builtin_wasm_memory_atomic_wait32(&word, 0, 1000) == 2);
    CHECK(tls_value == 100 + id && errno == 40 + id % 11);
    CHECK(stack[0] == (unsigned char)id && stack[8191] == (unsigned char)(id + 17));
    return argument;
}
int main(void) {
    tls_value = 71;
    for (intptr_t id = 1; id <= 256; id++) {
        pthread_t thread; void *value = NULL;
        CHECK(pthread_create(&thread, NULL, run, (void *)id) == 0);
        CHECK(pthread_join(thread, &value) == 0 && (intptr_t)value == id);
        CHECK(initialized == 1 && tls_value == 71);
    }
    puts("grouped-sdk-pthread-churn PASS 256");
    return 0;
}
