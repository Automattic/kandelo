#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#define HEAP (8 << 20)
#define THREADS 4

static char *heap;

static int all(const char *bytes, size_t length, char value) {
    for (size_t i = 0; i < length; i++) if (bytes[i] != value) return 0;
    return 1;
}

static int reap(pid_t pid) {
    int status = -1;
    if (pid <= 0 || waitpid(pid, &status, 0) != pid || !WIFEXITED(status)) return -1;
    return WEXITSTATUS(status);
}

static void *stride(void *arg) {
    for (size_t i = (long)arg; i < HEAP; i += THREADS) heap[i] = 1;
    return NULL;
}

static void *part(void *arg) {
    long index = (long)arg;
    memset(heap + index * (HEAP / THREADS), (char)(10 + index), HEAP / THREADS);
    return NULL;
}

static int run(void *(*entry)(void *)) {
    pthread_t threads[THREADS];
    int ok = 1;
    for (long i = 0; i < THREADS; i++) ok = ok && pthread_create(&threads[i], NULL, entry, (void *)i) == 0;
    for (long i = 0; i < THREADS; i++) ok = ok && pthread_join(threads[i], NULL) == 0;
    return ok;
}

static int run_writers(void) {
    int ok = run(stride) && all(heap, HEAP, 1) && run(part);
    for (long i = 0; i < THREADS; i++) ok = ok && all(heap + i * (HEAP / THREADS), HEAP / THREADS, (char)(10 + i));
    return ok;
}

int main(void) {
    int to_child[2], to_parent[2];
    char byte = 0;
    heap = malloc(HEAP);
    memset(heap, 7, HEAP);
    if (pipe(to_child) || pipe(to_parent)) return 3;

    pid_t child = fork();
    if (child == 0) {
        int before = read(to_child[0], &byte, 1) == 1 && all(heap, HEAP, 7);
        int wrote = run_writers();
        write(to_parent[1], &byte, 1);
        int got = read(to_child[0], &byte, 1);
        int after = got == 1;
        printf("child before=%d wrote=%d after=%d got=%d errno=%d\n", before, wrote, after, got, errno);
        fflush(stdout);
        _exit(before && wrote && after ? 42 : 2);
    }
    int wrote = run_writers();
    memset(heap, 5, HEAP);
    write(to_child[1], &byte, 1);
    int answered = read(to_parent[0], &byte, 1) == 1;
    int kept = all(heap, HEAP, 5);
    int again = run_writers();
    write(to_child[1], &byte, 1);
    int code = reap(child);
    printf("parent wrote=%d answered=%d kept=%d again=%d child=%d\n", wrote, answered, kept, again, code);
    return !(wrote && answered && kept && again && code == 42);
}
