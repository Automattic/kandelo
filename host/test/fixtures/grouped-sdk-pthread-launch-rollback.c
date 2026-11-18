#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#define CHECK(e) do { if (!(e)) { fprintf(stderr,"FAIL line=%d errno=%d: %s\n",__LINE__,errno,#e); _Exit(1); } } while(0)
static __thread int value = 13;
static void *run(void *argument) {
    volatile unsigned char stack[8192];
    CHECK(value == 13); value = 91; stack[0] = 17; stack[8191] = 42;
    CHECK(stack[0] == 17 && stack[8191] == 42 && value == 91);
    return argument;
}
int main(void) {
    value = 71;
    for (intptr_t index = 1; index <= 16; index++) {
        pthread_t thread; void *result = NULL;
        CHECK(pthread_create(&thread, NULL, run, (void *)index) == EAGAIN);
        CHECK(pthread_create(&thread, NULL, run, (void *)index) == 0);
        CHECK(pthread_join(thread, &result) == 0 && (intptr_t)result == index);
        CHECK(value == 71);
    }
    puts("grouped-sdk-pthread-launch-rollback PASS 16");
    return 0;
}
