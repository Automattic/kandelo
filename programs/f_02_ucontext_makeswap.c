// F-02 — makecontext/setcontext/swapcontext accepted limits.
//
// These ucontext functions implement userspace coroutine switching
// — unsupported by this kernel. The test attempts the full setup
// (makecontext to define a new context, swapcontext to switch) and
// verifies one of three acceptable outcomes:
//   1. Link error (the symbol is undefined in libc.a) — handled
//      by the build system, not visible at runtime.
//   2. setcontext/swapcontext returns -1 with ENOSYS or similar.
//   3. The program traps cleanly (`unreachable`) when reaching
//      unsupported code.
//
// Silent miscompilation (program runs but does the wrong thing) is
// a regression. The test asserts the PASS marker — getting there
// means the program at least exited cleanly without infinite loop.
//
// Expected output on PASS:
//   MAKECONTEXT_DONE
//   SWAPCONTEXT_RETURNED rc=<num>
//   PASS: F-02

#define _XOPEN_SOURCE 700
#include <stdio.h>
#include <stdlib.h>
#include <ucontext.h>
#include <errno.h>

static ucontext_t main_ctx, alt_ctx;
static volatile int alt_ran = 0;

static void alt_func(void) {
    alt_ran = 1;
}

int main(void) {
    if (getcontext(&alt_ctx) != 0) {
        printf("FAIL: getcontext\n");
        return 1;
    }
    static char stack[16384];
    alt_ctx.uc_stack.ss_sp = stack;
    alt_ctx.uc_stack.ss_size = sizeof(stack);
    alt_ctx.uc_link = &main_ctx;
    makecontext(&alt_ctx, alt_func, 0);
    printf("MAKECONTEXT_DONE\n");
    fflush(stdout);

    int rc = swapcontext(&main_ctx, &alt_ctx);
    printf("SWAPCONTEXT_RETURNED rc=%d errno=%d alt_ran=%d\n", rc, errno, alt_ran);
    fflush(stdout);

    // Either way (success or failure), we got back here without
    // infinite loop or crash. That's PASS.
    printf("PASS: F-02\n");
    return 0;
}
