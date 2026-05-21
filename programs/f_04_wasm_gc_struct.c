// F-04 — accepted-limit fixture: program uses a concrete wasm-GC
// reference (struct.new of a defined type) on the fork path (A5).
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Stub: same family as F-03. WAT fixture pending — needs a struct
// type definition + struct.new + ref local on the fork path.
//
// Replace with the real WAT fixture + driver harness when wired up.

#include <stdio.h>

int main(void) {
    printf("STUB: F-04 struct.new accepted limit (WAT + driver pending)\n");
    return 1;  // Intentional FAIL — test driver marks this it.fails.
}
