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
 * AT THE SHARED DEPTH (4,096), AND SO IT FAILS MID-UNWIND, AS ON NODE. Until
 * 2026-09-26 this copy defined P11_DEEP_FORK_DEPTH 2048: wasmtime's default
 * 512 KiB Wasm stack did not hold 4,096 instrumented activations, and no
 * depth both fit that stack and committed more frames than one 64 KiB
 * continuation chunk holds (2,560 still fit one chunk; 2,750 exhausted the
 * stack), so the deep fork's ENOMEM landed at the seal instead. The native
 * host now gives guests an 8 MiB Wasm stack (`GUEST_MAX_WASM_STACK_BYTES` in
 * ../src/lib.rs), and `smoke_fork_continuation_enomem_preserves_parent`
 * asserts the abort cause the fork module recorded is the mid-unwind frame
 * reserve, not the seal.
 */
#include "../../../programs/p_11_fork_continuation_enomem.c"
