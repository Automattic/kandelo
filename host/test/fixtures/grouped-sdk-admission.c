#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

#define CHECK(e) do { if (!(e)) { fprintf(stderr, "FAIL line=%d errno=%d: %s\n", __LINE__, errno, #e); _Exit(1); } } while (0)
#define CHILDREN 26
#define THREADS 66
static pthread_barrier_t barrier;
static _Atomic int ready;

static void *thread(void *argument) {
    atomic_fetch_add(&ready, 1);
    int result = pthread_barrier_wait(&barrier);
    CHECK(result == 0 || result == PTHREAD_BARRIER_SERIAL_THREAD);
    return argument;
}

int main(void) {
    int arrived[2], release[2];
    pid_t children[CHILDREN];
    CHECK(pipe(arrived) == 0 && pipe(release) == 0);
    for (int i = 0; i < CHILDREN; i++) {
        children[i] = fork();
        CHECK(children[i] >= 0);
        if (children[i] == 0) {
            CHECK(close(arrived[0]) == 0 && close(release[1]) == 0);
            char token = 'r';
            CHECK(write(arrived[1], &token, 1) == 1);
            CHECK(read(release[0], &token, 1) == 1 && token == 'g');
            _Exit(20 + i);
        }
    }
    CHECK(close(arrived[1]) == 0 && close(release[0]) == 0);
    for (int i = 0; i < CHILDREN; i++) {
        char token;
        CHECK(read(arrived[0], &token, 1) == 1 && token == 'r');
    }
    // Every child is alive together; serial fork/reap would miss a count cap.
    for (int i = 0; i < CHILDREN; i++) CHECK(write(release[1], "g", 1) == 1);
    for (int i = 0; i < CHILDREN; i++) {
        int status;
        CHECK(waitpid(children[i], &status, 0) == children[i]);
        CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 20 + i);
    }
    CHECK(close(arrived[0]) == 0 && close(release[1]) == 0);

    pthread_t threads[THREADS];
    pthread_attr_t attr;
    CHECK(pthread_attr_init(&attr) == 0);
    CHECK(pthread_attr_setstacksize(&attr, 64 * 1024) == 0);
    CHECK(pthread_barrier_init(&barrier, NULL, THREADS + 1) == 0);
    for (intptr_t i = 0; i < THREADS; i++)
        CHECK(pthread_create(&threads[i], &attr, thread, (void *)(i + 1)) == 0);
    int result = pthread_barrier_wait(&barrier);
    CHECK(result == 0 || result == PTHREAD_BARRIER_SERIAL_THREAD);
    CHECK(atomic_load(&ready) == THREADS);
    for (intptr_t i = 0; i < THREADS; i++) {
        void *value;
        CHECK(pthread_join(threads[i], &value) == 0);
        CHECK((intptr_t)value == i + 1);
    }
    CHECK(pthread_barrier_destroy(&barrier) == 0);
    CHECK(pthread_attr_destroy(&attr) == 0);
    puts("grouped-sdk-admission PASS 26-live-children 66-live-pthreads");
    return 0;
}
