// P-10 — fork below enough recursive Wasm activations to exceed the retired
// 60 KiB contiguous continuation reserve.

#include <errno.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

__attribute__((noinline))
static pid_t fork_at_depth(int depth) {
    if (depth == 0) return fork();

    pid_t result = fork_at_depth(depth - 1);
    // Keep this as genuine non-tail recursion and retain scalar state across
    // the call. The empty asm preserves the runtime value while preventing
    // the optimizer from proving it constant across the recursive call.
    __asm__ volatile("" : "+r"(depth));
    return result + (depth == -1);
}

int main(void) {
    printf("PRE_DEEP_FORK\n");
    fflush(stdout);

    pid_t pid = fork_at_depth(4096);
    if (pid < 0) {
        printf("FAIL: deep fork errno=%d\n", errno);
        return 1;
    }
    if (pid == 0) {
        printf("DEEP_CHILD: ok\n");
        fflush(stdout);
        _exit(0);
    }

    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        printf("FAIL: deep waitpid errno=%d\n", errno);
        return 1;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        printf("FAIL: deep child status=%d\n", status);
        return 1;
    }
    printf("DEEP_PARENT: child=%d\n", pid);
    printf("PASS: P-10\n");
    return 0;
}
