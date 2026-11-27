#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#define HEAP (4 << 20)

static int all(const char *bytes, size_t length, char value) {
    for (size_t i = 0; i < length; i++) if (bytes[i] != value) return 0;
    return 1;
}

static int reap(pid_t pid) {
    int status = -1;
    if (pid <= 0 || waitpid(pid, &status, 0) != pid || !WIFEXITED(status)) return -1;
    return WEXITSTATUS(status);
}

int main(void) {
    char *heap = malloc(HEAP);
    int gate[2];
    char byte = 0;
    memset(heap, 7, HEAP);
    if (pipe(gate)) return 9;

    pid_t first = fork();
    if (first == 0) {
        close(gate[1]);
        read(gate[0], &byte, 1);
        _exit(all(heap, HEAP, 7) ? 41 : 1);
    }
    memset(heap, 3, HEAP);

    pid_t second = fork();
    if (second == 0) {
        int inherited = all(heap, HEAP, 3);
        memset(heap, 9, HEAP);
        _exit(inherited && all(heap, HEAP, 9) ? 42 : 2);
    }
    int late = reap(second);
    int kept = all(heap, HEAP, 3);
    close(gate[1]);
    int early = reap(first);
    printf("first=%d second=%d kept=%d\n", early, late, kept);
    return !(early == 41 && late == 42 && kept);
}
