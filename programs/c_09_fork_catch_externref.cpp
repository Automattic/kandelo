// C-09 — plain catch arm whose operand is an externref (A4 aux table
// — externref) + fork.
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Stub: as with C-08, no direct C-source surface for an externref
// catch operand. The exercise needs a hand-written WAT fixture that
// constructs a try_table with `catch_ref` of an externref-typed tag,
// then runs it through the instrumented host.
//
// Expected output once implemented:
//   PASS: C-09

#include <cstdio>

int main(void) {
    printf("STUB: C-09 externref catch operand (pending A4 implementation)\n");
    return 1;  // Intentional FAIL — test driver marks this it.fails.
}
