/*
 * A guest that faults by executing Wasm `unreachable` without ever calling
 * exit(2).
 *
 * `__builtin_trap()` lowers to the `unreachable` instruction. That is the same
 * trap the native host once treated as "the exit path unwinding the guest",
 * so a genuine fault ended silently instead of as SIGILL, and a process that
 * trapped this way never told the kernel it was gone. The test
 * (`smoke_guest_unreachable_is_a_fault` in ../src/lib.rs) requires the
 * status every Kandelo host records for SIGILL: 128 + 4 = 132.
 *
 * The write before the trap proves the program ran to the fault rather than
 * failing to start.
 */
#include <unistd.h>

int main(void) {
    static const char msg[] = "about to trap\n";
    write(1, msg, sizeof(msg) - 1);
    __builtin_trap();
}
