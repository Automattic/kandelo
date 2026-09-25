/*
 * A fork child that faults on Wasm `unreachable`, and a parent that waits
 * for it.
 *
 * The child never calls exit(2): it traps. The kernel must still learn that
 * the child is gone, or the parent's waitpid() never returns -- the shape of
 * the native fork smoke tests that ended in 30-second timeouts instead of a
 * visible fault. The parent reports the status it reaped, in the shell's
 * `$?` form, as its own exit code:
 *
 *   - killed by a signal:  128 + WTERMSIG
 *   - exited:              WEXITSTATUS
 *
 * Folding both into one number keeps the fixture's verdict independent of
 * whether a host reports the fault as WIFSIGNALED (the JavaScript hosts) or,
 * for now, as a plain exit with status 132 (host-native, which does not yet
 * mark the process signaled; see docs/future-improvements.md). Either way a
 * SIGILL child yields 132. Exit 9 means the fork itself failed.
 *
 * Built through the SDK and instrumented with the production fork
 * instrumenter by build-fixtures.sh (INSTRUMENTED_FIXTURES).
 */
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
    pid_t p = fork();
    if (p < 0) {
        _exit(9);
    }
    if (p == 0) {
        write(1, "child\n", 6);
        __builtin_trap();
    }
    int st = 0;
    if (waitpid(p, &st, 0) != p) {
        _exit(10);
    }
    write(1, "parent\n", 7);
    if (WIFSIGNALED(st)) {
        _exit(128 + WTERMSIG(st));
    }
    _exit(WEXITSTATUS(st));
}
