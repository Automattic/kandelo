#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#define CHECK(e) do { if (!(e)) { fprintf(stderr,"FAIL line=%d errno=%d: %s\n",__LINE__,errno,#e); _Exit(1); } } while(0)
static __thread int value = 13;
static void *run(void *argument) {
    volatile unsigned char stack[8192];
    CHECK(value == 13);
    value = 91; stack[0] = 17; stack[8191] = 42;
    CHECK(stack[0] == 17 && stack[8191] == 42 && value == 91);
    return argument;
}
int main(void) {
    size_t length = 34 * 65536;
    unsigned char *held = mmap(NULL, length, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0);
    CHECK(held != MAP_FAILED); held[0] = 31; held[length-1] = 99;
    value = 71;
    pthread_t thread; void *result = NULL;
    int first = pthread_create(&thread, NULL, run, (void *)123);
    printf("first-pthread=%d\n", first); fflush(stdout);
    /* musl maps clone's ENOMEM to EAGAIN and unmaps the failed stack. */
    CHECK(first == EAGAIN);
    CHECK(held[0] == 31 && held[length-1] == 99);
    /* The same stack is recreated on retry. Free scratch headroom, but not
     * enough for another four-page control slot: the cancelled row must reuse. */
    CHECK(munmap(held + length - 2*65536, 2*65536) == 0);
    length -= 2*65536; held[length-1] = 99;
    CHECK(pthread_create(&thread, NULL, run, (void *)123) == 0);
    CHECK(pthread_join(thread, &result) == 0 && result == (void *)123);
    CHECK(value == 71 && held[0] == 31 && held[length-1] == 99);
    CHECK(munmap(held, length) == 0);
    puts("grouped-sdk-pthread-rollback PASS");
    return 0;
}
