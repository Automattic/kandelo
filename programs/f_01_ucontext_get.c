// F-01 — accepted-limit fixture: program calls getcontext() (A1).
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Stub: ucontext is an accepted limit. The musl wasm sysroot exposes
// the header but provides no implementation in libc.a, so a real
// fixture that calls `getcontext` would fail to link. Linking against
// a stub libc + asserting the link failure is the correct test, and
// belongs in the commit that wires up the build-system harness for
// accepted-limit checks (currently planned alongside the doc updates
// in commit 10 of the mega-PR).
//
// For commit 1 this exists as a stub so the test driver has a target
// to reference — replace when the link-failure harness lands.

#include <stdio.h>

int main(void) {
    printf("STUB: F-01 getcontext accepted limit (link-failure harness pending)\n");
    return 1;  // Intentional FAIL — test driver marks this it.fails.
}
