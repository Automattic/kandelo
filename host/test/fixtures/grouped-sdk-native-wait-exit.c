#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>
#define CHECK(e) do { if (!(e)) { fprintf(stderr,"FAIL line=%d errno=%d: %s\n",__LINE__,errno,#e); _Exit(1); } } while(0)
static _Atomic int ready32, ready64, returned;
static _Atomic int word32;
static _Alignas(8) _Atomic long long word64;
static void *waiter(void *wide) {
    unsigned result;
    if (wide) {
        atomic_store(&ready64, 1);
        result = __builtin_wasm_memory_atomic_wait64((long long *)&word64, 0, -1);
    } else {
        atomic_store(&ready32, 1);
        result = __builtin_wasm_memory_atomic_wait32((int *)&word32, 0, -1);
    }
    CHECK(result == 0);
    atomic_fetch_or(&returned, wide ? 2 : 1);
    return wide;
}
static void run_child(int command, int survivor) {
    pthread_t a, b; char token;
    CHECK(pthread_create(&a, 0, waiter, 0) == 0 && pthread_create(&b, 0, waiter, (void *)1) == 0);
    CHECK(read(command, &token, 1) == 1 && token == 'w' && survivor);
    CHECK(atomic_load(&ready32) == 1 && atomic_load(&ready64) == 1 && atomic_load(&returned) == 0);
    atomic_store(&word32, 1); atomic_store(&word64, 1);
    CHECK(__builtin_wasm_memory_atomic_notify((int *)&word32, 1) == 1);
    CHECK(__builtin_wasm_memory_atomic_notify((int *)&word64, 1) == 1);
    void *value;
    CHECK(pthread_join(a, &value) == 0 && value == 0);
    CHECK(pthread_join(b, &value) == 0 && value == (void *)1);
    CHECK(atomic_load(&returned) == 3);
    _Exit(31);
}
int main(void) {
    int control[2], status; char token;
    CHECK(pipe(control) == 0);
    pid_t victim = fork(); CHECK(victim >= 0);
    if (!victim) { CHECK(close(control[1]) == 0); run_child(control[0], 0); }
    pid_t survivor = fork(); CHECK(survivor >= 0);
    if (!survivor) { CHECK(close(control[1]) == 0); run_child(control[0], 1); }
    CHECK(close(control[0]) == 0);
    printf("native-ready victim=%d survivor=%d ready32=%lu ready64=%lu returned=%lu\n", victim, survivor,
        (unsigned long)(uintptr_t)&ready32, (unsigned long)(uintptr_t)&ready64, (unsigned long)(uintptr_t)&returned);
    fflush(stdout);
    /* Host releases only after observing four exact published native waits. */
    CHECK(read(0, &token, 1) == 1 && token == 'k');
    CHECK(kill(victim, SIGKILL) == 0 && waitpid(victim, &status, 0) == victim);
    CHECK(WIFSIGNALED(status) && WTERMSIG(status) == SIGKILL);
    puts("native-victim-reaped"); fflush(stdout);
    /* Host proves victim retirement and the survivor's two waits still live. */
    CHECK(read(0, &token, 1) == 1 && token == 'w');
    CHECK(write(control[1], "w", 1) == 1 && close(control[1]) == 0);
    CHECK(waitpid(survivor, &status, 0) == survivor && WIFEXITED(status) && WEXITSTATUS(status) == 31);
    CHECK(atomic_load(&ready32) == 0 && atomic_load(&ready64) == 0 && atomic_load(&returned) == 0);
    puts("grouped-sdk-native-wait-exit PASS wait32-wait64-kill-peer-notify");
    return 0;
}
