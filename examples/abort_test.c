/*
 * abort_test.c — verify abort() actually terminates the process.
 *
 * Regression test for the wasm-port `a_crash` bug fixed in
 * musl-overlay/arch/wasm32posix/atomic_arch.h. Background:
 *
 *   musl's abort() calls `raise(SIGABRT)` and then loops on
 *   `for(;;) a_crash()` as a backstop in case the signal didn't
 *   terminate the process. The generic `a_crash` writes to address 0,
 *   relying on Linux's NULL-page protection to SIGSEGV. On wasm32
 *   address 0 is the start of valid linear memory — the write
 *   succeeds silently and the loop spins forever in user-space with
 *   no syscalls. abort() then never returns.
 *
 *   With the overlay's `a_crash` defined as `__builtin_trap()`, the
 *   loop's first iteration emits a wasm `unreachable` instruction and
 *   the runtime traps the worker.
 *
 * Expected behaviour: the process terminates and the "after-abort"
 * line is never printed. Without the fix the host hangs waiting for
 * an exit notification that never comes.
 */
#include <stdio.h>
#include <stdlib.h>

int main(void)
{
    fprintf(stderr, "before-abort\n");
    fflush(stderr);
    abort();
    fprintf(stderr, "after-abort-SHOULD-NEVER-REACH\n");
    return 1;
}
