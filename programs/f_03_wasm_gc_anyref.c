// F-03 — accepted-limit fixture: program uses wasm-GC reference
// type (anyref / eqref) on the fork path (A5).
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Stub: wasm-GC reference types have no C-source surface. The fixture
// needs a hand-written WAT module containing an `anyref` or `eqref`
// local on the fork path; the test driver invokes `wasm-fork-instrument`
// directly and asserts it exits non-zero with a clear error message
// naming the function and ref type (the existing classify_ref panic
// is the current mechanism).
//
// Replace this stub with the WAT fixture + driver harness when the
// test is wired up in the commit that documents the accepted limit.

#include <stdio.h>

int main(void) {
    printf("STUB: F-03 anyref accepted limit (WAT + driver pending)\n");
    return 1;  // Intentional FAIL — test driver marks this it.fails.
}
