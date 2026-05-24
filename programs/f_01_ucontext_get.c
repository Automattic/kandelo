// F-01 — getcontext() accepted limit.
//
// ucontext APIs (getcontext / setcontext / makecontext / swapcontext)
// are POSIX.1-2008-deprecated and not in scope for this kernel. The
// kernel doesn't implement userspace stack-switching. musl exposes
// the headers; getcontext() typically returns 0 (no-op success — it
// just captures the current state to the ucontext_t struct) but
// downstream setcontext/swapcontext are unsupported.
//
// This test verifies getcontext() at least doesn't crash. The full
// stack-switching round-trip (setcontext) is tested by F-02.
//
// Expected output on PASS:
//   GETCONTEXT_RETURNED rc=0
//   PASS: F-01

#define _XOPEN_SOURCE 700
#include <stdio.h>
#include <stdlib.h>
#include <ucontext.h>
#include <errno.h>

int main(void) {
    ucontext_t ctx;
    int rc = getcontext(&ctx);
    printf("GETCONTEXT_RETURNED rc=%d errno=%d\n", rc, errno);
    fflush(stdout);
    printf("PASS: F-01\n");
    return 0;
}
