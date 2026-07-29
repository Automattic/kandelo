#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#define WASM_PAGE_SIZE 65536u
#define GROW_PAGES 3u

static size_t memory_pages(void)
{
    return (size_t)__builtin_wasm_memory_size(0);
}

int main(void)
{
    const size_t original_pages = memory_pages();
    if (__builtin_wasm_memory_grow(0, GROW_PAGES) == (size_t)-1) {
        fprintf(stderr, "memory.grow failed\n");
        return 1;
    }

    const size_t expected_pages = original_pages + GROW_PAGES;
    volatile uint8_t *last_byte =
        (volatile uint8_t *)(expected_pages * WASM_PAGE_SIZE - 1);
    *last_byte = 0xa5;

    pid_t child = fork();
    if (child < 0) {
        fprintf(stderr, "fork failed: %s\n", strerror(errno));
        return 2;
    }
    if (child == 0) {
        if (memory_pages() != expected_pages) {
            fprintf(
                stderr,
                "child memory pages=%zu expected=%zu\n",
                memory_pages(),
                expected_pages
            );
            _exit(3);
        }
        if (*last_byte != 0xa5) {
            fprintf(stderr, "child lost grown-page boundary byte\n");
            _exit(4);
        }
        // The child must own an independent fork snapshot.
        *last_byte = 0x5a;
        _exit(0);
    }

    int status = 0;
    if (waitpid(child, &status, 0) != child) {
        fprintf(stderr, "waitpid failed: %s\n", strerror(errno));
        return 5;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "child status=%d\n", status);
        return 6;
    }
    if (memory_pages() != expected_pages || *last_byte != 0xa5) {
        fprintf(stderr, "child did not preserve parent snapshot isolation\n");
        return 7;
    }

    printf(
        "FORK_MEMORY_CLONE_PASS pages=%zu boundary=%u\n",
        expected_pages,
        (unsigned)*last_byte
    );
    return 0;
}
