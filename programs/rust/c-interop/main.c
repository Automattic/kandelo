/* C program linked against the Rust library (rustlib/). Prints one line
 * per check and exits nonzero if any check fails. */
#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "kandelo_interop.h"

static int failures;

static void check(int ok, const char *what) {
    printf("%s %s\n", ok ? "ok" : "FAIL", what);
    if (!ok) failures++;
}

static int add_seven(int x) { return x + 7; }

int main(void) {
    /* Same 128-bit intrinsics in Rust (compiler_builtins) and C (compiler-rt). */
    uint64_t a = UINT64_MAX, b = 3, d = 5;
    uint64_t from_c = (uint64_t)(((unsigned __int128)a * b) / d);
    check(interop_u128_muldiv(a, b, d) == from_c && from_c == 11068046444225730969ULL,
          "u128 muldiv matches C");

    char *greeting = interop_greeting("C");
    check(strcmp(greeting, "hello, C, from Rust") == 0, "Rust-owned string");
    interop_free_string(greeting);

    check(interop_apply(add_seven, 1) == 15, "C callback called from Rust");

    errno = 0;
    check(close(-1) == -1 && interop_last_errno() == EBADF, "shared errno");

    interop_setenv("INTEROP_FROM_RUST", "yes");
    const char *v = getenv("INTEROP_FROM_RUST");
    check(v && strcmp(v, "yes") == 0, "shared environment");

    const char *path = "/tmp/kandelo-interop-c.txt";
    char buf[64] = {0};
    FILE *f = NULL;
    int wrote = interop_write_file(path, "written by Rust std::fs") == 0;
    if (wrote && (f = fopen(path, "r")) != NULL) {
        fgets(buf, sizeof buf, f);
        fclose(f);
    }
    unlink(path);
    check(strcmp(buf, "written by Rust std::fs") == 0, "Rust std::fs, C stdio");

    check(interop_parallel_sum(4, 1000) == 2004000, "Rust std::thread from C");

    printf("%s\n", failures ? "C-CALLS-RUST FAILED" : "C-CALLS-RUST OK");
    return failures ? 1 : 0;
}
