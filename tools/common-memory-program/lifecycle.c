#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

static int private_value = 42;
static volatile sig_atomic_t caught;
static void on_signal(int signal) { if (signal == SIGUSR1) ++caught; }

int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "after-exec")) {
        if (private_value != 42 || caught) return 31;
        unsigned char *fresh = mmap(0, 65536, PROT_READ|PROT_WRITE,
            MAP_PRIVATE|MAP_ANONYMOUS, -1, 0);
        if (fresh == MAP_FAILED) return 32;
        for (unsigned i=0; i<65536; ++i) if (fresh[i]) return 33;
        return munmap(fresh, 65536) ? 34 : 0;
    }
    int32_t *shared = mmap(0, 65536, PROT_READ|PROT_WRITE,
        MAP_SHARED|MAP_ANONYMOUS, -1, 0);
    if (shared == MAP_FAILED) return 10;
    struct sigaction action = {.sa_handler = on_signal};
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGUSR1, &action, 0)) return 11;
    pid_t parent = getpid();
    for (unsigned cycle=0; cycle<32; ++cycle) {
        pid_t child = fork();
        if (child < 0) return 12;
        if (!child) {
            if (private_value != 42) _exit(13);
            private_value = 99;
            shared[0] = cycle + 1;
            if (kill(parent, SIGUSR1)) _exit(14);
            if (cycle % 2) {
                if (kill(getpid(), SIGKILL)) _exit(15);
                _exit(16);
            }
            execl("/tmp/common-memory-lifecycle.wasm", "lifecycle", "after-exec", (char *)0);
            _exit(17);
        }
        int status = -1;
        pid_t waited;
        do { waited = waitpid(child, &status, 0); } while (waited < 0 && errno == EINTR);
        if (waited != child) {
            fprintf(stderr, "waitpid child=%d result=%d errno=%d\n", child, waited, errno);
            return 18;
        }
        if (cycle % 2) {
            if (!WIFSIGNALED(status) || WTERMSIG(status) != SIGKILL) return 19;
        } else if (!WIFEXITED(status) || WEXITSTATUS(status)) {
            fprintf(stderr, "exec child cycle=%u status=%d\n", cycle, status);
            return 20;
        }
        if (private_value != 42 || shared[0] != (int32_t)(cycle+1)) return 21;
    }
    if (caught != 32 || munmap(shared, 65536)) return 22;
    puts("PASS lifecycle: 32 forks, 16 execs, 16 SIGKILL exits, caught signals, shared publication, private isolation and zeroed new mappings");
    return 0;
}
