/*
 * Recurse argv[1] calls deep on the Wasm (engine) stack, on the main thread
 * or -- with argv[2] == "thread" -- on a pthread, and print how deep it got.
 *
 * The native host gives guest Wasm an 8 MiB stack (`GUEST_MAX_WASM_STACK_
 * BYTES` in ../src/lib.rs) on OS threads spawned with room for it. The tests
 * (`smoke_guest_recursion_*` in ../src/lib.rs) run a depth that overflowed
 * Wasmtime's 512 KiB default and must now complete, and a far deeper one that
 * must still end as the stack-overflow SIGSEGV (128 + 11) rather than crash
 * the host process. The pthread arm covers the worker-thread spawn path.
 *
 * The recursion uses no address-taken locals, so it consumes only the engine
 * stack and never the guest's shadow stack in linear memory: the depth this
 * reaches is the Wasm stack limit, not the SDK's 8 MiB `-z stack-size`.
 */
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

__attribute__((noinline))
static unsigned recurse(unsigned depth) {
    if (depth == 0) return 0;
    unsigned reached = recurse(depth - 1);
    // WHY: keep each activation live across the call, so the compiler cannot
    // turn the recursion into a loop (as P-11's fork_at_depth does).
    __asm__ volatile("" : "+r"(reached));
    return reached + 1;
}

static void *run(void *arg) {
    unsigned depth = *(unsigned *)arg;
    unsigned reached = recurse(depth);
    printf("DEPTH_REACHED %u\n", reached);
    fflush(stdout);
    return NULL;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        printf("usage: native_stack_depth DEPTH [thread]\n");
        return 2;
    }
    unsigned depth = (unsigned)strtoul(argv[1], NULL, 10);
    if (argc > 2 && strcmp(argv[2], "thread") == 0) {
        pthread_t thread;
        if (pthread_create(&thread, NULL, run, &depth) != 0) {
            printf("FAIL: pthread_create\n");
            return 1;
        }
        if (pthread_join(thread, NULL) != 0) {
            printf("FAIL: pthread_join\n");
            return 1;
        }
    } else {
        run(&depth);
    }
    return 0;
}
