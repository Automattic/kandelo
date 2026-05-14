// P-03 — fork() from inside a critical section (pthread_mutex_lock
// held); child inherits locked mutex per POSIX.
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Documented POSIX behaviour. The child must see the mutex locked
// (and is responsible for unlocking before any subsequent lock).
// Verifies the kernel copies process-private mutex state into the
// child correctly across fork.
//
// Expected output on PASS:
//   LOCKED
//   PRE_FORK
//   CHILD: trylock=EBUSY
//   CHILD: unlocked
//   PARENT: child=<pid>
//   PASS: P-03

#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <unistd.h>
#include <pthread.h>
#include <sys/wait.h>

static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;

int main(void) {
    if (pthread_mutex_lock(&mu) != 0) {
        printf("FAIL: lock\n");
        return 1;
    }
    printf("LOCKED\n");
    printf("PRE_FORK\n");
    fflush(stdout);

    pid_t pid = fork();
    if (pid < 0) {
        printf("FAIL: fork errno=%d\n", errno);
        return 1;
    }
    if (pid == 0) {
        // POSIX: mutex was locked at fork() — should still be locked
        // in the child. trylock must report EBUSY (or thread-owner
        // mismatch on PTHREAD_MUTEX_NORMAL implementations that don't
        // track owner; either way, "lock succeeded" would be wrong).
        int rc = pthread_mutex_trylock(&mu);
        if (rc == 0) {
            printf("FAIL: trylock succeeded in child (mutex was unlocked)\n");
            fflush(stdout);
            _exit(1);
        }
        printf("CHILD: trylock=EBUSY\n");
        if (pthread_mutex_unlock(&mu) != 0) {
            printf("FAIL: child unlock\n");
            fflush(stdout);
            _exit(1);
        }
        printf("CHILD: unlocked\n");
        fflush(stdout);
        _exit(0);
    }
    printf("PARENT: child=%d\n", pid);
    fflush(stdout);

    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        printf("FAIL: waitpid errno=%d\n", errno);
        return 1;
    }
    pthread_mutex_unlock(&mu);

    if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
        printf("PASS: P-03\n");
        return 0;
    }
    printf("FAIL: child status=%d\n", status);
    return 1;
}
