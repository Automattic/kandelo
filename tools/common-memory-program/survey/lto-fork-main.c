#define _GNU_SOURCE
#include "lto-fork.h"
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

struct child_report { uint32_t fork_value, leaf_value, private_value, pointer_ok; };
static void publish(uint32_t *word, uint32_t value) {
    __atomic_store_n(word, value, __ATOMIC_SEQ_CST);
    __builtin_wasm_memory_atomic_notify((int32_t *)word, 1);
}
static int await_value(uint32_t *word, uint32_t value, int64_t timeout) {
    for (unsigned attempt = 0; attempt < 4; attempt++) {
        uint32_t old = __atomic_load_n(word, __ATOMIC_SEQ_CST);
        if (old == value) return 0;
        if (__builtin_wasm_memory_atomic_wait32((int32_t *)word, old, timeout) == 2)
            return -1;
    }
    return __atomic_load_n(word, __ATOMIC_SEQ_CST) == value ? 0 : -1;
}
static int transfer(int fd, void *data, size_t size, int writing) {
    unsigned char *bytes = data;
    while (size) {
        ssize_t count = writing ? write(fd, bytes, size) : read(fd, bytes, size);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return -1;
        bytes += count; size -= count;
    }
    return 0;
}
int main(int argc, char **argv) {
    int shared_mode = argc == 3 && !strcmp(argv[2], "shared");
    if (argc < 2 || strcmp(argv[1], "fork")) return 10;
    int channel[2];
    if (pipe(channel)) return 11;
    struct lto_state *state = malloc(sizeof(*state));
    if (!state) return 12;
    *state = (struct lto_state){.value = 17, .salt = 3, .branch = -1, .self = state};
    uint32_t *shared = NULL;
    if (shared_mode) {
        shared = mmap(NULL, 65536, PROT_READ | PROT_WRITE,
                      MAP_SHARED | MAP_ANONYMOUS, -1, 0);
        if (shared == MAP_FAILED) return 13;
        __atomic_store_n(shared, 0, __ATOMIC_SEQ_CST);
    }
    // argv selects the table slot at runtime, not a compile-time constant.
    unsigned slot = (unsigned)(argv[1][0] == 'f');
    uint32_t fork_value = lto_dispatch(state, slot, 19);
    if (state->branch < 0 || fork_value == UINT32_MAX) return 14;
    if (!state->branch) {
        close(channel[0]);
        uint32_t leaf_value = lto_dispatch(state, 0, 5);
        struct child_report report = {fork_value, leaf_value, state->value,
                                      state->self == state && state->callback == lto_callbacks[0]};
        if (shared_mode) {
            __atomic_store_n(shared + 1, state->value, __ATOMIC_SEQ_CST);
            publish(shared, 1);
            // No syscall after publication until the parent's raw-memory
            // acknowledgement. Pipe/exit synchronization cannot satisfy this.
            if (await_value(shared + 2, 2, 4000000000LL)) _exit(24);
        }
        int failed = transfer(channel[1], &report, sizeof(report), 1);
        close(channel[1]);
        _exit(failed ? 15 : 0);
    }
    close(channel[1]);
    int live_shared = 1;
    if (shared_mode) {
        // Observe before read/waitpid: ordinary mappings can synchronize at
        // syscall boundaries, which would be a false live-sharing proof.
        live_shared = !await_value(shared, 1, 2000000000LL) &&
                      __atomic_load_n(shared + 1, __ATOMIC_SEQ_CST) == 104;
        if (live_shared) publish(shared + 2, 2);
    }
    struct child_report report = {0};
    int received = transfer(channel[0], &report, sizeof(report), 0);
    close(channel[0]);
    int status = 0;
    if (waitpid(state->branch, &status, 0) != state->branch || !WIFEXITED(status)) return 16;
    // A separate-memory negative must observe the failed raw handshake and
    // the child's acknowledgement timeout, and still reap that child.
    if (shared_mode && !live_shared)
        return WEXITSTATUS(status) == 24 && received ? 26 : 20;
    if (WEXITSTATUS(status) || received) return 16;
    if (fork_value != 73 || state->value != 17 || state->self != state ||
        report.fork_value != 155 || report.leaf_value != 124 ||
        report.private_value != 104 || report.pointer_ok != 1) return 17;
    if (lto_dispatch(state, 0, 5) != 42 || state->value != 22 ||
        state->callback != lto_callbacks[0]) return 18;
    if (shared_mode && munmap(shared, 65536)) return 19;
    free(state);
    printf("PASS LTO fork: indirect callback, live frames, canonical pointers, private copy%s\n",
           shared_mode ? ", live shared bytes" : "");
    return 0;
}
