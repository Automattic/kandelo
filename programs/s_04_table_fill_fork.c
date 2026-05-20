// S-04 — table.fill before fork() (B3 table operation class).
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Stub: table.fill operates on a wasm table (typed funcref/externref
// elements), not on linear memory. C source can't directly emit
// table.fill — the only natural source is hand-written WAT.
//
// For commit 1 this exists as a placeholder so the test stub can
// reference it. Replace with the real WAT fixture (or a custom
// post-processing pass that injects table.fill) when the side-effect
// class lands under switch-dispatch + trampoline.
//
// Expected output once implemented:
//   PASS: S-04

#include <stdio.h>

int main(void) {
    printf("STUB: S-04 table.fill (WAT fixture pending)\n");
    return 1;  // Intentional FAIL — test driver marks this it.fails.
}
