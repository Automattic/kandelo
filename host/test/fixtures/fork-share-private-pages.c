#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

#define HEAP (1 << 20)
#define MAP (16 << 20)

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
    char *map = mmap(NULL, MAP, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    memset(heap, 7, HEAP);
    memset(map, 5, MAP);

    pid_t child = fork();
    if (child == 0) {
        int inherited = all(heap, HEAP, 7) && all(map, MAP, 5);
        memset(heap, 9, HEAP);
        memset(map + MAP / 2, 9, MAP / 2);
        char *grown = malloc(4 << 20);
        memset(grown, 4, 4 << 20);
        pid_t grandchild = fork();
        if (grandchild == 0) {
            int seen = all(heap, HEAP, 9) && all(map, MAP / 2, 5) && all(grown, 4 << 20, 4);
            memset(grown, 1, 4 << 20);
            _exit(seen ? 43 : 1);
        }
        int code = reap(grandchild);
        int kept = all(grown, 4 << 20, 4) && all(map + MAP / 2, MAP / 2, 9);
        printf("child inherited=%d grandchild=%d kept=%d\n", inherited, code, kept);
        fflush(stdout);
        _exit(inherited && code == 43 && kept ? 42 : 2);
    }
    memset(heap, 3, HEAP / 2);
    int code = reap(child);
    int kept = all(heap, HEAP / 2, 3) && all(heap + HEAP / 2, HEAP / 2, 7) && all(map, MAP, 5);
    printf("parent forked=%d child=%d kept=%d\n", child > 0, code, kept);
    return !(child > 0 && code == 42 && kept);
}
