/*
 * wasm_trap_test.c — emit a wasm `unreachable` trap directly from user
 * code, without going through SYS_exit_group.
 *
 * This is the minimal reproducer for the host-side bug fixed in the
 * PR adding `{type:"exit"}` handlers in
 * host/src/node-kernel-worker-entry.ts: if a process worker traps in
 * user space (e.g. assertion failure inside mallocng, abort()'s
 * `for(;;) a_crash()` loop, or any direct `__builtin_trap()`),
 * worker-main.ts catches the `unreachable` RuntimeError and posts
 * `{type:"exit", pid, status:0}` to its parent. Without a handler for
 * that message in the kernel-worker entry, the host's `host.spawn()`
 * promise never resolves and tests time out.
 *
 * With the fix, this program terminates promptly and `spawn()`
 * resolves. Expected exit code is 0 because worker-main treats
 * `unreachable` as the normal `_Exit` exit pattern.
 */
#include <stdio.h>

int main(void)
{
    fprintf(stderr, "before-trap\n");
    fflush(stderr);
    __builtin_trap();
    fprintf(stderr, "after-trap-SHOULD-NEVER-REACH\n");
    return 1;
}
