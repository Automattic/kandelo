#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#define HEAP (1 << 20)
#define GROWN (4 << 20)

static char *heap;
static char *grown;
static atomic_int go;
static atomic_int parked;

static int all(const char *bytes, size_t length, char value) {
    for (size_t i = 0; i < length; i++) if (bytes[i] != value) return 0;
    return 1;
}

static int reap(pid_t pid) {
    int status = -1;
    if (pid <= 0 || waitpid(pid, &status, 0) != pid || !WIFEXITED(status)) return -1;
    return WEXITSTATUS(status);
}

static void *fill_seven(void *unused) {
    memset(heap, 7, HEAP);
    return NULL;
}

static void *sibling(void *unused) {
    atomic_store(&parked, 1);
    while (!atomic_load(&go)) usleep(1000);
    memset(heap, 3, HEAP / 2);
    return NULL;
}

static void *child_thread(void *unused) {
    memset(heap, 9, HEAP);
    grown = malloc(GROWN);
    memset(grown, 4, GROWN);
    pid_t grandchild = fork();
    if (grandchild == 0) {
        int seen = all(heap, HEAP, 9) && all(grown, GROWN, 4);
        memset(grown, 1, GROWN);
        _exit(seen ? 43 : 1);
    }
    return (void *)(long)reap(grandchild);
}

int main(void) {
    pthread_t thread;
    void *result = NULL;
    heap = malloc(HEAP);
    memset(heap, 0, HEAP);

    int created = pthread_create(&thread, NULL, fill_seven, NULL) == 0 && pthread_join(thread, NULL) == 0;
    int filled = all(heap, HEAP, 7);

    created = created && pthread_create(&thread, NULL, sibling, NULL) == 0;
    while (!atomic_load(&parked)) usleep(1000);

    pid_t child = fork();
    if (child == 0) {
        pthread_t inner;
        int inherited = all(heap, HEAP, 7);
        int started = pthread_create(&inner, NULL, child_thread, NULL) == 0 && pthread_join(inner, &result) == 0;
        int code = (int)(long)result;
        int kept = all(heap, HEAP, 9) && grown && all(grown, GROWN, 4);
        printf("child inherited=%d started=%d grandchild=%d kept=%d\n", inherited, started, code, kept);
        fflush(stdout);
        _exit(inherited && started && code == 43 && kept ? 42 : 2);
    }
    atomic_store(&go, 1);
    int joined = pthread_join(thread, NULL) == 0;
    int code = reap(child);
    int kept = all(heap, HEAP / 2, 3) && all(heap + HEAP / 2, HEAP / 2, 7);
    printf("parent created=%d filled=%d forked=%d joined=%d child=%d kept=%d\n", created, filled, child > 0, joined, code, kept);
    return !(created && filled && child > 0 && joined && code == 42 && kept);
}
