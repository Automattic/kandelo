#define _GNU_SOURCE

#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

static void *mark_started(void *opaque)
{
    atomic_store_explicit((atomic_int *)opaque, 1, memory_order_release);
    return NULL;
}

static int run_thread(atomic_int *started)
{
    pthread_t thread;
    int error = pthread_create(&thread, NULL, mark_started, started);
    if (error != 0) {
        fprintf(stderr, "pthread_create failed: %d\n", error);
        return -1;
    }
    error = pthread_join(thread, NULL);
    if (error != 0) {
        fprintf(stderr, "pthread_join failed: %d\n", error);
        return -1;
    }
    if (!atomic_load_explicit(started, memory_order_acquire)) {
        fputs("pthread callback did not run\n", stderr);
        return -1;
    }
    return 0;
}

int main(void)
{
    atomic_int first_started = 0;
    atomic_int second_started = 0;

    if (run_thread(&first_started) != 0)
        return 1;

    pid_t child = fork();
    if (child < 0) {
        perror("fork");
        return 2;
    }
    if (child == 0)
        _exit(0);

    int status = 0;
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status) ||
        WEXITSTATUS(status) != 0) {
        fprintf(stderr, "child status mismatch: %#x\n", status);
        return 3;
    }

    if (run_thread(&second_started) != 0)
        return 4;

    puts("PTHREAD_CHANNEL_REUSE_PASS");
    return 0;
}
