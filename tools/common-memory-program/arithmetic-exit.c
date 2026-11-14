#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* After one readiness store the child spins without memory operations or
 * syscalls. Retirement must reach a compiler-inserted loop stop check. */
int main(void) {
    _Atomic uint32_t *counter = mmap(0, 65536, PROT_READ | PROT_WRITE,
        MAP_SHARED | MAP_ANONYMOUS, -1, 0);
    if (counter == MAP_FAILED) return 10;
    for (unsigned cycle = 0; cycle < 4; ++cycle) {
        atomic_store(counter, 0);
        pid_t child = fork();
        if (child < 0) return 11;
        if (!child) {
            atomic_store(counter, 64);
            for (;;) __asm__ volatile ("" ::: "memory");
        }
        unsigned attempts = 0;
        while (atomic_load(counter) < 32) {
            struct timespec delay = {.tv_nsec = 1000000};
            if (nanosleep(&delay, 0) && errno != EINTR) return 17;
            if (++attempts == 10000) return 12;
        }
        if (kill(child, SIGKILL)) return 13;
        int status;
        pid_t waited;
        do { waited = waitpid(child, &status, 0); }
        while (waited < 0 && errno == EINTR);
        if (waited != child || !WIFSIGNALED(status)
            || WTERMSIG(status) != SIGKILL) return 14;
        uint32_t stopped = atomic_load(counter);
        struct timespec settle = {.tv_nsec = 20000000};
        while (nanosleep(&settle, &settle)) {
            if (errno != EINTR) return 18;
        }
        if (atomic_load(counter) != stopped) return 15;
    }
    if (munmap(counter, 65536)) return 16;
    puts("PASS arithmetic exit: 4 memory-free spinning children stopped before waitpid");
    return 0;
}
