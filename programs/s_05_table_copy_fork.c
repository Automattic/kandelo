// S-05 — table.copy before fork() (B3 table operation class).
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Stub: as with S-04, table.copy has no C-source surface. Hand-written
// WAT fixture pending.
//
// Expected output once implemented:
//   PASS: S-05

#include <stdio.h>

int main(void) {
    printf("STUB: S-05 table.copy (WAT fixture pending)\n");
    return 1;  // Intentional FAIL — test driver marks this it.fails.
}
