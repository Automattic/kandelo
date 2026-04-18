/* exec-bench.c — Exec into /bin/hello to measure exec latency.
 * The TypeScript wrapper measures total wall clock time. */
#include <unistd.h>
#include <stdio.h>

int main(void) {
    char *argv[] = { "hello", NULL };
    char *envp[] = { NULL };
    execve("/bin/hello", argv, envp);
    perror("execve");
    return 1;
}
