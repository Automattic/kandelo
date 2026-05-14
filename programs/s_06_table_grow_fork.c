// S-06 — table.grow before fork() (B3 table operation class).
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Stub: table.grow has no C-source surface in our SDK. Hand-written
// WAT fixture pending.
//
// Expected output once implemented:
//   PASS: S-06

#include <stdio.h>

int main(void) {
    printf("STUB: S-06 table.grow (WAT fixture pending)\n");
    return 1;  // Intentional FAIL — test driver marks this it.fails.
}
