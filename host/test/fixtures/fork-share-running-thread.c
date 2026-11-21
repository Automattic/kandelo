#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

#define WORDS (1 << 18)

static volatile unsigned *heap;
static atomic_int running;
static atomic_int stop;

static int reap(pid_t pid) {
    int status = -1;
    if (pid <= 0 || waitpid(pid, &status, 0) != pid || !WIFEXITED(status)) return -1;
    return WEXITSTATUS(status);
}

/* Writes every word in a loop with no syscall, so the thread is never parked. */
static void *spinner(void *unused) {
    unsigned round = 1;
    atomic_store(&running, 1);
    while (!atomic_load(&stop)) {
        for (size_t i = 0; i < WORDS; i++) heap[i] = round;
        round++;
    }
    return (void *)(long)round;
}

static unsigned long sum(void) {
    unsigned long total = 0;
    for (size_t i = 0; i < WORDS; i++) total += heap[i];
    return total;
}

int main(void) {
    pthread_t thread;
    void *rounds = NULL;
    heap = calloc(WORDS, sizeof(unsigned));
    int created = pthread_create(&thread, NULL, spinner, NULL) == 0;
    while (!atomic_load(&running)) usleep(1000);
    usleep(20000);

    pid_t child = fork();
    if (child == 0) {
        unsigned long first = sum();
        usleep(50000);
        unsigned long second = sum();
        usleep(50000);
        unsigned long third = sum();
        int stable = first == second && second == third;
        printf("child stable=%d nonzero=%d\n", stable, first != 0);
        fflush(stdout);
        _exit(stable && first != 0 ? 42 : 2);
    }
    unsigned before = heap[0];
    usleep(50000);
    unsigned after = heap[0];
    int code = reap(child);
    atomic_store(&stop, 1);
    int joined = pthread_join(thread, &rounds) == 0;
    unsigned last = (unsigned)(long)rounds - 1;
    int kept = 1;
    for (size_t i = 0; i < WORDS; i++) if (heap[i] != last) kept = 0;
    printf("parent created=%d forked=%d advanced=%d joined=%d child=%d kept=%d\n", created, child > 0, after > before, joined, code, kept);
    return !(created && child > 0 && after > before && joined && code == 42 && kept);
}
