// F-03 — accepted-limit fixture: program uses wasm-GC reference
// type (anyref / eqref) on the fork path (A5).
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// wasm-GC reference types have no C-source surface, so the authoritative
// rejection coverage lives in crates/fork-instrument/tests/coverage_wat.rs.
// That hand-written WAT invokes the instrumenter directly and requires a
// precise, non-panicking unsupported-reference diagnostic.

#include <stdio.h>

int main(void) {
    printf("STUB: F-03 anyref accepted limit (covered by WAT)\n");
    return 1;  // Intentional FAIL — runtime coverage skips this C-only stub.
}
