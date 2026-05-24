// D-09 — switch-dispatch trampoline: fork in an irreducible CFG.
//
// LLVM lowers a `select` over function pointers into a computed-call
// site that the wasm `call_indirect` then routes. From the
// instrumenter's perspective the call graph contains a join with two
// predecessors that both re-enter via the indirect call, producing an
// irreducible region. Today this either forces guard-dispatch or hits
// the call-graph fallback. The trampoline must cover it after the
// pivot.
//
// The pattern below is contrived — we pick between two helper
// pointers via an input flag, then call one. The instrumenter's call
// graph sees both as fork-path roots reached via the same indirect
// call site.
//
// Expected output on PASS:
//   ROUTE: <a|b>
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   PASS: D-09

#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <unistd.h>
#include <sys/wait.h>

typedef int (*forker_t)(const char *);

static int forker_a(const char *tag) {
    printf("ROUTE: %s\n", tag);
    printf("PRE_FORK\n");
    fflush(stdout);
    pid_t pid = fork();
    if (pid < 0) return -1;
    if (pid == 0) { printf("CHILD: ok\n"); fflush(stdout); _exit(0); }
    printf("PARENT: child=%d\n", pid);
    fflush(stdout);
    int st = 0;
    if (waitpid(pid, &st, 0) < 0) return -1;
    return (WIFEXITED(st) && WEXITSTATUS(st) == 0) ? 0 : -1;
}

static int forker_b(const char *tag) {
    printf("ROUTE: %s\n", tag);
    printf("PRE_FORK\n");
    fflush(stdout);
    pid_t pid = fork();
    if (pid < 0) return -1;
    if (pid == 0) { printf("CHILD: ok\n"); fflush(stdout); _exit(0); }
    printf("PARENT: child=%d\n", pid);
    fflush(stdout);
    int st = 0;
    if (waitpid(pid, &st, 0) < 0) return -1;
    return (WIFEXITED(st) && WEXITSTATUS(st) == 0) ? 0 : -1;
}

int main(int argc, char **argv) {
    int pick_b = (argc > 1) && (argv[1][0] == 'b');
    // Indirect select between two fork-path roots.
    forker_t fn = pick_b ? forker_b : forker_a;
    const char *tag = pick_b ? "b" : "a";
    if (fn(tag) != 0) {
        printf("FAIL: forker rc != 0\n");
        return 1;
    }
    printf("PASS: D-09\n");
    return 0;
}
