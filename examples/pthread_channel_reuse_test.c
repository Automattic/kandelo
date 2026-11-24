#define _GNU_SOURCE

#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

#define TLS_ALIGNMENT (128 * 1024)
#define TLS_SIZE (256 * 1024)

static _Alignas(TLS_ALIGNMENT) _Thread_local volatile unsigned char tls[TLS_SIZE];
static _Thread_local volatile int tls_seed = 7;

static int wait_success(pid_t child)
{
    int status = 0;
    return child > 0 && waitpid(child, &status, 0) == child &&
        WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

static int inherited_tls_is_live(void)
{
    /* An inherited TLS block must remain reserved in the child's address
       space, even though it now runs on the main syscall channel. */
    void *page = (void *)(uintptr_t)&tls[0];
    if (mmap(page, 64 * 1024, PROT_READ | PROT_WRITE,
        MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0) != MAP_FAILED)
        return 0;
    return tls_seed == 19 && tls[0] == 42 && tls[TLS_SIZE - 1] == 93;
}

static void *mark_started(void *opaque)
{
    if ((uintptr_t)&tls[0] % TLS_ALIGNMENT || tls_seed != 7 ||
        tls[0] != 0 || tls[TLS_SIZE - 1] != 0)
        return NULL;
    tls_seed = 19;
    tls[0] = 42;
    tls[TLS_SIZE - 1] = 93;

    pid_t child = fork();
    if (child == 0) {
        if (!inherited_tls_is_live()) _exit(5);
        pid_t grandchild = fork();
        if (grandchild == 0) _exit(inherited_tls_is_live() ? 0 : 6);
        _exit(wait_success(grandchild) ? 0 : 7);
    }
    if (!wait_success(child) || tls_seed != 19 || tls[0] != 42 || tls[TLS_SIZE - 1] != 93)
        return NULL;

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
        fputs("pthread TLS initialization or fork preservation failed\n", stderr);
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

    if (tls_seed != 7 || tls[0] != 0 || tls[TLS_SIZE - 1] != 0)
        return 8;

    puts("PTHREAD_CHANNEL_REUSE_LARGE_TLS_PASS");
    return 0;
}
