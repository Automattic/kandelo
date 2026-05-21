// S-07 — direct call returning non-nullable funcref before fork(),
// result consumed after fork (B4).
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Stub: non-nullable funcref return types only appear in modules with
// the typed-function-references proposal enabled. The current SDK
// does not emit them from C source. WAT fixture pending.
//
// Expected output once implemented:
//   PASS: S-07

#include <stdio.h>

int main(void) {
    printf("STUB: S-07 non-nullable funcref result (WAT fixture pending)\n");
    return 1;  // Intentional FAIL — test driver marks this it.fails.
}
