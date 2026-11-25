#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#ifdef EXEC_OLD_THREADS
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
static _Atomic int busy_word, ready32, ready64, returned;
static _Atomic int word32;
static _Alignas(8) _Atomic long long word64;
static void *old_thread(void *kind) {
    if (!kind) { for (;;) atomic_fetch_add(&busy_word, 1); }
    if (kind == (void *)1) {
        atomic_store(&ready32, 1);
        __builtin_wasm_memory_atomic_wait32((int *)&word32, 0, -1);
    } else {
        atomic_store(&ready64, 1);
        __builtin_wasm_memory_atomic_wait64((long long *)&word64, 0, -1);
    }
    atomic_fetch_add(&returned, 1);
    return NULL;
}
#endif

static volatile int image_value = 11;
static __thread volatile int tls_value = 37;
static volatile int constructors;
__attribute__((constructor)) static void construct(void) { ++constructors; }

int main(int argc, char **argv) {
    int step, fd, cloexec;
    pid_t original;
    if (argc == 3) {
        step = 0; original = getpid();
        fd = open("/tmp/exec-inherited", O_CREAT | O_TRUNC | O_RDWR, 0600);
        cloexec = open("/tmp/exec-closed", O_CREAT | O_TRUNC | O_RDWR | O_CLOEXEC, 0600);
        if (fd < 0 || cloexec < 0 || fd == cloexec) return 10;
    } else if (argc == 5) {
        step = atoi(argv[1]); original = atoi(argv[2]);
        fd = atoi(argv[3]); cloexec = atoi(argv[4]);
        errno = 0;
        if (fcntl(cloexec, F_GETFD) != -1 || errno != EBADF) return 11;
    } else return 12;
    if (getpid() != original || constructors != 1 || image_value != 11 || tls_value != 37) return 13;
    if (step < 0 || step > 16 || lseek(fd, 0, SEEK_END) != step) return 14;
    if (step == 16) {
        if (close(fd) != 0) return 15;
        printf("grouped-sdk-exec-handoff PASS 16 pid=%d\n", (int)original);
        return 0;
    }
#ifdef EXEC_OLD_THREADS
    pthread_t threads[3];
    for (intptr_t kind = 0; kind < 3; ++kind) {
        if (pthread_create(&threads[kind], NULL, old_thread, (void *)kind)) return 18;
    }
    printf("exec-ready step=%d busy=%lu ready32=%lu ready64=%lu returned=%lu\n", step,
        (unsigned long)(uintptr_t)&busy_word, (unsigned long)(uintptr_t)&ready32,
        (unsigned long)(uintptr_t)&ready64, (unsigned long)(uintptr_t)&returned);
    fflush(stdout);
    char ack;
    if (read(0, &ack, 1) != 1 || ack != 'k') return 19;
    if (atomic_load(&returned) != 0) return 20;
#endif
    if (write(fd, "x", 1) != 1) return 16;
    image_value = 99; tls_value = 99;
    char next[16], pid[16], inherited[16], closed[16];
    snprintf(next, sizeof next, "%d", step + 1);
    snprintf(pid, sizeof pid, "%d", (int)original);
    snprintf(inherited, sizeof inherited, "%d", fd);
    snprintf(closed, sizeof closed, "%d", cloexec);
    char *const replacement[] = {"replacement", next, pid, inherited, closed, NULL};
    char *const environment[] = {"PATH=/bin", NULL};
    execve("/bin/grouped-exec-target", replacement, environment);
    fprintf(stderr, "successful exec returned step=%d errno=%d\n", step, errno);
    return 17;
}
