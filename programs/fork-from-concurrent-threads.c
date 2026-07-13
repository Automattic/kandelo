// Two pthreads fork concurrently from deliberately different call stacks.
// Each fork child must replay the stack captured by its calling thread without
// another thread's simultaneous unwind corrupting that continuation.

#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

#define ROUNDS 16
#define DEEP_FRAMES 64

static pthread_barrier_t fork_barrier;
static volatile int failures;

static void record_failure(const char *where, int round, int value) {
    printf("FAIL: %s round=%d value=%d errno=%d\n", where, round, value, errno);
    fflush(stdout);
    __atomic_fetch_add(&failures, 1, __ATOMIC_RELAXED);
}

static int wait_for_child(pid_t pid, int round, const char *where) {
    int status = 0;
    if (pid < 0) {
        record_failure(where, round, (int)pid);
        return -1;
    }
    if (pid == 0) {
        _exit(0);
    }
    if (waitpid(pid, &status, 0) != pid) {
        record_failure("waitpid", round, (int)pid);
        return -1;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        record_failure("child status", round, status);
        return -1;
    }
    return 0;
}

static __attribute__((noinline)) pid_t shallow_fork(void) {
    int rc = pthread_barrier_wait(&fork_barrier);
    if (rc != 0 && rc != PTHREAD_BARRIER_SERIAL_THREAD) {
        errno = rc;
        return -1;
    }
    return fork();
}

static __attribute__((noinline)) pid_t deep_fork(
    unsigned depth,
    volatile uint32_t *checksum
) {
    uint32_t local = depth * 2654435761u + *checksum;
    pid_t pid;

    if (depth == 0) {
        int rc = pthread_barrier_wait(&fork_barrier);
        if (rc != 0 && rc != PTHREAD_BARRIER_SERIAL_THREAD) {
            errno = rc;
            return -1;
        }
        pid = fork();
    } else {
        pid = deep_fork(depth - 1, checksum);
    }

    // Keep every recursive activation live across fork(). This prevents tail
    // recursion and gives the two concurrent continuations different shapes.
    *checksum ^= local + depth + (uint32_t)(pid > 0 ? pid : 0);
    return pid;
}

static void *shallow_worker(void *unused) {
    (void)unused;
    for (int round = 0; round < ROUNDS; round++) {
        if (wait_for_child(shallow_fork(), round, "shallow fork") != 0) {
            break;
        }
    }
    return NULL;
}

static void *deep_worker(void *unused) {
    (void)unused;
    volatile uint32_t checksum = 0x12345678u;
    for (int round = 0; round < ROUNDS; round++) {
        if (wait_for_child(deep_fork(DEEP_FRAMES, &checksum), round, "deep fork") != 0) {
            break;
        }
    }
    return NULL;
}

int main(void) {
    pthread_t shallow;
    pthread_t deep;

    if (pthread_barrier_init(&fork_barrier, NULL, 2) != 0) {
        printf("FAIL: pthread_barrier_init\n");
        return 1;
    }
    if (pthread_create(&shallow, NULL, shallow_worker, NULL) != 0 ||
        pthread_create(&deep, NULL, deep_worker, NULL) != 0) {
        printf("FAIL: pthread_create\n");
        return 1;
    }

    pthread_join(shallow, NULL);
    pthread_join(deep, NULL);
    pthread_barrier_destroy(&fork_barrier);

    if (failures != 0) {
        printf("FAIL: failures=%d\n", failures);
        return 1;
    }
    printf("PASS: %d concurrent fork pairs\n", ROUNDS);
    return 0;
}
