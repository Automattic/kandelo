#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

#define WRITERS 3
#define WORDS (1 << 16)
#define FORKS 12

static volatile unsigned *region[WRITERS];
static atomic_int started;
static atomic_int stop;
static atomic_int stop_reader;
static atomic_long torn;

/* Fills its region and reads it back, with no syscall. A store that lands on
 * a page the thread no longer maps shows as a word of an earlier round. */
static void *writer(void *arg) {
    volatile unsigned *words = region[(long)arg];
    unsigned round = 1;
    atomic_fetch_add(&started, 1);
    while (!atomic_load(&stop)) {
        for (size_t i = 0; i < WORDS; i++) words[i] = round;
        for (size_t i = 0; i < WORDS; i++) if (words[i] != round) atomic_fetch_add(&torn, 1);
        round++;
    }
    return (void *)(long)round;
}

/* Loads in a loop with no store and no syscall, so it never parks. */
static void *reader(void *unused) {
    volatile unsigned *words = region[0];
    unsigned long total = 0;
    atomic_fetch_add(&started, 1);
    for (size_t i = 0; !atomic_load(&stop_reader); i = (i + 1) % WORDS) total += words[i];
    return (void *)total;
}

static unsigned long sum(void) {
    unsigned long total = 0;
    for (int w = 0; w < WRITERS; w++) for (size_t i = 0; i < WORDS; i++) total += region[w][i];
    return total;
}

static int forks(const char *label) {
    int good = 0;
    for (int i = 0; i < FORKS; i++) {
        pid_t child = fork();
        if (child == 0) {
            unsigned long first = sum();
            usleep(20000);
            unsigned long second = sum();
            _exit(first == second && first != 0 ? 42 : 2);
        }
        int status = -1;
        good += child > 0 && waitpid(child, &status, 0) == child
            && WIFEXITED(status) && WEXITSTATUS(status) == 42;
        usleep(5000);
    }
    printf("%s good=%d torn=%ld\n", label, good, atomic_load(&torn));
    return good == FORKS;
}

int main(void) {
    pthread_t threads[WRITERS], idle;
    for (long w = 0; w < WRITERS; w++) {
        region[w] = calloc(WORDS, sizeof(unsigned));
        pthread_create(&threads[w], NULL, writer, (void *)w);
    }
    while (atomic_load(&started) < WRITERS) usleep(1000);
    usleep(20000);
    int ok = forks("writers");

    pthread_create(&idle, NULL, reader, NULL);
    while (atomic_load(&started) < WRITERS + 1) usleep(1000);
    ok &= forks("reader");
    atomic_store(&stop_reader, 1);
    pthread_join(idle, NULL);
    ok &= forks("after");

    atomic_store(&stop, 1);
    long rounds = 0;
    for (int w = 0; w < WRITERS; w++) {
        void *result = NULL;
        pthread_join(threads[w], &result);
        rounds += (long)result > 2;
    }
    printf("parent advanced=%ld torn=%ld\n", rounds, atomic_load(&torn));
    return !(ok && rounds == WRITERS && atomic_load(&torn) == 0);
}
