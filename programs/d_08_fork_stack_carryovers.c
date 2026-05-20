// D-08 — switch-dispatch trampoline: fork in a function whose
// top-level call sites have stack carryovers.
//
// LLVM frequently emits `*(sp + K) = call(...)`-style patterns: a
// shadow-stack slot is written with the result of a call. Under
// guard-dispatch's REWIND replay this re-runs the helper and stomps the
// slot with stale state. switch-dispatch (today) refuses to extract
// through these sites, forcing guard-dispatch. The trampoline must
// cover the case after the pivot.
//
// We force the carryover pattern by spilling a struct return into a
// local that's live across fork() and used afterwards.
//
// Expected output on PASS:
//   COMPUTED: x=<n> y=<n>
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   PASS: D-08

#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <unistd.h>
#include <sys/wait.h>

struct two_ints { int x; int y; };

// noinline so the result must be spilled to the shadow stack across
// the fork() call below.
__attribute__((noinline))
static struct two_ints make_pair(int seed) {
    struct two_ints r = { seed * 3, seed * 5 };
    return r;
}

int main(int argc, char **argv) {
    int seed = (argc > 1) ? atoi(argv[1]) : 7;
    struct two_ints pair = make_pair(seed);
    printf("COMPUTED: x=%d y=%d\n", pair.x, pair.y);
    fflush(stdout);

    printf("PRE_FORK\n");
    fflush(stdout);
    pid_t pid = fork();
    if (pid < 0) {
        printf("FAIL: fork errno=%d\n", errno);
        return 1;
    }
    if (pid == 0) {
        // Use the carried-over struct after fork to keep it live.
        printf("CHILD: ok x=%d y=%d\n", pair.x, pair.y);
        fflush(stdout);
        return 0;
    }
    printf("PARENT: child=%d x=%d y=%d\n", pid, pair.x, pair.y);
    fflush(stdout);
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        printf("FAIL: waitpid errno=%d\n", errno);
        return 1;
    }
    if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
        printf("PASS: D-08\n");
        return 0;
    }
    printf("FAIL: child status=%d\n", status);
    return 1;
}
