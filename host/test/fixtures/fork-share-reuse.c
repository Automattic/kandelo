/*
 * Forks many children that each write private copies of shared pages and
 * exit. The Memory of the group must stop growing: a later child uses the
 * pages that an exited child gave back.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#define PAGE 65536
#define PAGES 16
#define FORKS 64
#define WARM_FORKS 8

int main(void) {
    char *data = malloc(PAGES * PAGE);
    size_t warm = 0;
    int reaped = 0;

    memset(data, 0x11, PAGES * PAGE);
    for (int i = 0; i < FORKS; i++) {
        if (i == WARM_FORKS) warm = __builtin_wasm_memory_size(0);
        pid_t child = fork();
        if (child == 0) {
            for (int page = 0; page < PAGES; page++) data[page * PAGE] = (char)i;
            _exit(0);
        }
        int status = -1;
        waitpid(child, &status, 0);
        reaped += WIFEXITED(status) && WEXITSTATUS(status) == 0 && data[0] == 0x11;
    }
    size_t grown = __builtin_wasm_memory_size(0) - warm;
    printf("reaped=%d bounded=%d\n", reaped, grown < 8 * PAGES);
    return 0;
}
