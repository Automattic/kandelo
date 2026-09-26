/*
 * The native host's copy of P-11: fork() when the address space runs out,
 * first before the capture begins (the root allocation) and then after a deep
 * unwind has committed frames. Both must return ENOMEM with no child and a
 * usable parent, the pages must come back, and a later fork must succeed.
 *
 * The Node host runs the same source (`host/test/fork-instrument-coverage.
 * test.ts`, P-11), so it is shared by inclusion rather than copied; see
 * `native_thread_churn.c`.
 *
 * SHALLOWER THAN THE NODE COPY, AND SO IT FAILS AT THE SEAL, NOT MID-UNWIND.
 * wasmtime's default wasm stack (512 KiB) does not hold 4,096 instrumented
 * activations: the recursion traps with "call stack exhausted" before it
 * reaches fork(). And no depth both fits that stack and commits more frames
 * than one 64 KiB continuation chunk holds -- measured on 2026-09-26, 2,560
 * still fit one chunk (the failure landed at the seal's journal image) and
 * 2,750 exhausted the stack; widening each frame with more live values
 * widens the native frame in the same proportion (2,048 wide frames
 * exhausted it too). So on this host the deep fork's ENOMEM is the seal-time
 * one, which the fork module abort-replays exactly as it does the mid-unwind
 * one on Node, and the mid-unwind path waits on the native stack depth (lane
 * F step 4/5), not on the fork module.
 */
#define P11_DEEP_FORK_DEPTH 2048
#include "../../../programs/p_11_fork_continuation_enomem.c"
