// C-08 — plain catch arm whose operand is a funcref (A4 aux table —
// funcref) + fork.
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Stub: A4's per-program auxiliary table with index-based save/restore
// for funcref catch operands has no direct C-source surface — wasm-EH
// catch operands carry exception payloads, not function pointers.
// The realistic exercise is a hand-written WAT fixture or a C++
// program that uses std::function (which lowers to a closure object
// stored as a struct in linear memory, not a funcref).
//
// For commit 1 this file exists as a placeholder so the test stub can
// reference it. Replace with the real WAT fixture (or a C++
// std::function-based variant) when A4 lands.
//
// Expected output once implemented:
//   PASS: C-08

#include <cstdio>

int main(void) {
    // Placeholder. A4 funcref catch operands require either a
    // hand-written WAT module or specific compiler intrinsic patterns
    // that aren't yet decided.
    printf("STUB: C-08 funcref catch operand (pending A4 implementation)\n");
    return 1;  // Intentional FAIL — test driver marks this it.fails.
}
