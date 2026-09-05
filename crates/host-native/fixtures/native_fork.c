/*
 * N1-I4 Task 2: a REAL `fork()` — the guest calls `kernel.kernel_fork` DIRECTLY
 * (`libc/glue/channel_syscall.c:492-493,577-600), never through the generic
 * syscall dispatcher. The parent waits for the child and reports its decoded
 * `WEXITSTATUS`; the child (if it ever actually runs) writes "child\n" and
 * exits 3.
 *
 * Task 2's host-native scope does NOT yet drive the fm_* capture/replay
 * coordinator (Task 3) that would let the child resume execution at this
 * fork() call site, so on that host the child process is created (private
 * memory copy, guest `Instance`, co-resident fork-module) but never actually
 * runs any of this program — see `spawn_guest_thread`'s
 * `fork_child_pending_replay` doc comment. The PARENT side is fully real:
 * `fork()` returns the child's pid, `waitpid()` reaps it through the same
 * `wait_table`/parked-retry machinery `posix_spawn` already uses, and
 * "parent\n" is printed with the reaped `WEXITSTATUS`.
 *
 * Built through the SDK like the other fixtures; see fixtures/README.md.
 */
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
    pid_t p = fork();
    if (p == 0) {
        write(1, "child\n", 6);
        _exit(3);
    } else {
        int st;
        waitpid(p, &st, 0);
        write(1, "parent\n", 7);
        _exit(WEXITSTATUS(st));
    }
}
