#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
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
        // pthread_join releases the guest thread, not its native Worker realm.
        // Bound-resource samples need the host's exact retirement as well;
        // keep the parent from allocating its next stack before that fence.
        static const char checkpoint[] = "thread-retirement-checkpoint\n";
        CHECK(write(1, checkpoint, sizeof(checkpoint) - 1) == sizeof(checkpoint) - 1);
        char acknowledgement = 0;
        CHECK(read(0, &acknowledgement, 1) == 1 && acknowledgement == 'k');
    }
    puts("grouped-sdk-pthread-launch-rollback PASS 16");
    return 0;
}
