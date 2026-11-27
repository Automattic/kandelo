#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <sys/wait.h>
#include <unistd.h>
#include <errno.h>

#define CHECK(test) do { if (!(test)) { fprintf(stderr,"FAIL line=%d errno=%d: %s\n",__LINE__,errno,#test); _exit(1); } } while (0)
static int channel[2];
static void *run(void *argument) {
    CHECK((uintptr_t)argument == 0x314);
    pid_t child = fork();
    CHECK(child >= 0);
    if (!child) {
        // This task is now a process leader, while its continuation still
        // belongs to the original pthread entry rather than _start.
        pid_t grandchild = fork();
        CHECK(grandchild >= 0);
        if (!grandchild) {
            CHECK(write(channel[1], "g", 1) == 1);
            _exit(29);
        }
        int status;
        CHECK(waitpid(grandchild, &status, 0) == grandchild);
        CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 29);
        CHECK(write(channel[1], "c", 1) == 1);
        _exit(23);
    }
    int status;
    CHECK(waitpid(child, &status, 0) == child);
    CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 23);
    return (void *)(uintptr_t)0x77;
}
int main(void) {
    CHECK(pipe(channel) == 0);
    pthread_t thread;
    CHECK(pthread_create(&thread, NULL, run, (void *)(uintptr_t)0x314) == 0);
    void *result;
    CHECK(pthread_join(thread, &result) == 0);
    CHECK((uintptr_t)result == 0x77);
    char bytes[2];
    CHECK(read(channel[0], bytes, 1) == 1);
    CHECK(read(channel[0], bytes + 1, 1) == 1);
    CHECK(bytes[0] == 'g' && bytes[1] == 'c');
    CHECK(close(channel[0]) == 0 && close(channel[1]) == 0);
    puts("grouped-sdk-pthread-fork PASS");
    return 0;
}
