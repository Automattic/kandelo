/*
 * Minimal stdin reader: reads stdin to EOF, prints byte count, exits.
 *
 * Regression test for two failure modes that have appeared together:
 *   (1) read(0) blocking forever when the host has no stdin set or has
 *       exhausted its buffer (the host should signal EOF, not EAGAIN).
 *   (2) any cancellable-syscall hang caused by the user binary linking
 *       against a stale sysroot — pre-Apr-2026 libc.a is missing the
 *       musl-overlay-defined __syscall_cp_check, leaving an unresolved
 *       env import that silently traps when first invoked. Symptom: the
 *       program prints `starting` (via stdio's first write) and then
 *       never makes another syscall. Fix: rebuild musl via
 *       scripts/build-musl.sh.
 *
 * Drive via:
 *   echo "" | npx tsx host/test/run-program.ts --program programs/stdin-reader.wasm
 * or under dash with `< file` redirection to exercise the FastCGI/dinit
 * stdin-redirect-to-spawned-child shape.
 */
#include <stdio.h>
#include <unistd.h>
#include <errno.h>

int main(void) {
    char buf[4096];
    long total = 0;
    ssize_t n;

    while ((n = read(0, buf, sizeof(buf))) > 0) {
        total += n;
    }
    if (n < 0) {
        fprintf(stderr, "stdin-reader: read error, errno=%d\n", errno);
        return 1;
    }
    fprintf(stderr, "stdin-reader: read %ld bytes, got EOF\n", total);
    return 0;
}
