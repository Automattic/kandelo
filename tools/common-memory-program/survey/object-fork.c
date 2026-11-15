#define _GNU_SOURCE
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/mman.h>
#include <sys/wait.h>

struct record { uint32_t value; struct record *pointer; uint32_t salt; };
// Volatile retains all four field accesses. Exported/noinline keeps a real
// call-free callee for the post-fork VM-04 proof, including child reentry.
__attribute__((noinline))
uint32_t object_touch(volatile struct record *r, uint32_t value) {
    r->value = value;
    r->pointer = (struct record *)r;
    return r->value + r->salt;
}
__attribute__((noinline))
uint32_t object_sum(volatile struct record *r) { return r->value + r->salt; }

static void publish(int32_t *p, int32_t value) {
    __atomic_store_n(p, value, __ATOMIC_SEQ_CST);
    __builtin_wasm_memory_atomic_notify(p, 1);
}
static int await_word(int32_t *p, int32_t value) {
    for (unsigned attempt = 0; attempt < 4; attempt++) {
        int32_t old = __atomic_load_n(p, __ATOMIC_SEQ_CST);
        if (old == value) return 0;
        if (__builtin_wasm_memory_atomic_wait32(p, old, 2000000000LL) == 2) return -1;
    }
    return __atomic_load_n(p, __ATOMIC_SEQ_CST) == value ? 0 : -1;
}
int main(void) {
    struct record *private = malloc(sizeof(*private));
    if (!private) return 20;
    int32_t *page = mmap(NULL, 65536, PROT_READ | PROT_WRITE,
        MAP_SHARED | MAP_ANONYMOUS, -1, 0);
    if (page == MAP_FAILED) return 21;
    struct record *shared = (struct record *)(page + 16);
    private->salt = 3; shared->salt = 5;
    if (object_touch(private, 17) != 20 || object_touch(shared, 41) != 46) return 22;
    pid_t child = fork();
    if (child < 0) return 23;
    if (!child) {
        if (private->pointer != private || shared->pointer != shared) _exit(24);
        if (object_touch(private, 99) != 102 || object_touch(shared, 42) != 47) _exit(25);
        publish(page, 1);
        if (await_word(page + 1, 2)) _exit(30);
        int32_t *replacement = mmap(page, 65536, PROT_READ | PROT_WRITE,
            MAP_FIXED | MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        if (replacement != page) _exit(31);
        struct record *r = (struct record *)(replacement + 16);
        r->salt = 9;
        if (object_touch(r, 77) != 86 || r->pointer != r) _exit(32);
        if (mprotect(replacement, 65536, PROT_READ) || object_sum(r) != 86) _exit(33);
        if (mprotect(replacement, 65536, PROT_READ | PROT_WRITE)) _exit(34);
        int32_t *moved = mremap(replacement, 65536, 131072, MREMAP_MAYMOVE);
        if (moved == MAP_FAILED) _exit(35);
        r = (struct record *)(moved + 16);
        if (object_touch(r, 88) != 97 || r->pointer != r) _exit(36);
        if (munmap(moved, 131072)) _exit(37);
        _exit(0);
    }
    if (await_word(page, 1)) return 26;
    if (object_sum(private) != 20 || object_sum(shared) != 47 ||
        private->pointer != private || shared->pointer != shared) return 27;
    publish(page + 1, 2);
    int status = 0;
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status)) return 28;
    if (object_sum(private) != 20 || object_sum(shared) != 47) return 29;
    puts("PASS real fork: guarded object callees, canonical pointers, private isolation, live shared fields, fixed replacement, protection, remap and unmap");
    return 0;
}
