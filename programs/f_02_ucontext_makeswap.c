// F-02 — accepted-limit fixture: program uses makecontext() /
// swapcontext() (A1).
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Stub: as with F-01, the musl wasm sysroot exposes the header but
// provides no implementation. Real test = build-time link-failure
// assertion (commit 10 of the mega-PR).

#include <stdio.h>

int main(void) {
    printf("STUB: F-02 swapcontext accepted limit (link-failure harness pending)\n");
    return 1;  // Intentional FAIL — test driver marks this it.fails.
}
