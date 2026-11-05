#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#define FORKS 32
#define MEMORY_PAGES 512u

int main(void)
{
    // WHY: fork-churn-guest.test.ts sizes the process memory budget to three
    // memories of exactly this size, so three retiring children fill the
    // host's retired-memory backlog.
    size_t pages = (size_t)__builtin_wasm_memory_size(0);
    if (pages > MEMORY_PAGES ||
        (pages < MEMORY_PAGES &&
         __builtin_wasm_memory_grow(0, MEMORY_PAGES - pages) == (size_t)-1)) {
        fprintf(
            stderr,
            "cannot size memory to %u pages from %zu\n",
            MEMORY_PAGES,
            pages
        );
        return 1;
    }

    for (int iteration = 0; iteration < FORKS; iteration++) {
        pid_t child = fork();
        if (child < 0) {
            fprintf(
                stderr,
                "fork iteration %d failed: %s\n",
                iteration,
                strerror(errno)
            );
            return 2;
        }
        if (child == 0) _exit(0);

        int status = 0;
        if (waitpid(child, &status, 0) != child) {
            fprintf(
                stderr,
                "waitpid iteration %d failed: %s\n",
                iteration,
                strerror(errno)
            );
            return 3;
        }
        if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
            fprintf(stderr, "child iteration %d status=%d\n", iteration, status);
            return 4;
        }
    }
    printf("FORK_CHURN_PASS forks=%d\n", FORKS);
    return 0;
}
