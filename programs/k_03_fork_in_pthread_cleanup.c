// K-03 — fork from inside a pthread_cleanup_push handler.
//
// Coverage matrix: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
// Cleanup handlers are address-taken callbacks reached via host-managed
// cancellation/cleanup unwinding. C4 in the unsupported-cases review;
// fixed by routing fork children from pthread workers through the saved
// pthread entry context.
//
// We fire the cleanup by allowing the thread to be cancelled at a
// cancellation point inside the thread body. The cleanup handler then
// fork()s and waits for the child.
//
// Expected output on PASS:
//   THREAD_STARTED
//   IN_CLEANUP arg=42
//   PRE_FORK
//   CHILD: ok
//   PARENT: child=<pid>
//   JOINED
//   PASS: K-03

#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <unistd.h>
#include <pthread.h>
#include <sys/wait.h>

static volatile int cleanup_done = 0;
static volatile int last_status = -1;

static void cleanup_handler(void *arg) {
    int v = (int)(intptr_t)arg;
    printf("IN_CLEANUP arg=%d\n", v);
    printf("PRE_FORK\n");
    fflush(stdout);
    pid_t pid = fork();
    if (pid < 0) {
        cleanup_done = 2;
        return;
    }
    if (pid == 0) {
        printf("CHILD: ok\n");
        fflush(stdout);
        _exit(0);
    }
    printf("PARENT: child=%d\n", pid);
    fflush(stdout);
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        cleanup_done = 2;
        return;
    }
    last_status = status;
    cleanup_done = 1;
}

static void *thread_body(void *arg) {
    (void)arg;
    pthread_cleanup_push(cleanup_handler, (void *)(intptr_t)42);

    printf("THREAD_STARTED\n");
    fflush(stdout);

    // Cancellation point — pthread_testcancel will trigger cleanup
    // when the cancel request arrives.
    while (1) {
        pthread_testcancel();
        usleep(10000);
    }

    pthread_cleanup_pop(0);
    return NULL;
}

int main(void) {
    pthread_t tid;
    if (pthread_create(&tid, NULL, thread_body, NULL) != 0) {
        printf("FAIL: pthread_create\n");
        return 1;
    }

    // Give the thread a moment to register the cleanup, then cancel.
    usleep(50000);
    if (pthread_cancel(tid) != 0) {
        printf("FAIL: pthread_cancel\n");
        return 1;
    }
    if (pthread_join(tid, NULL) != 0) {
        printf("FAIL: pthread_join\n");
        return 1;
    }

    printf("JOINED\n");
    fflush(stdout);
    if (cleanup_done != 1) {
        printf("FAIL: cleanup_done=%d\n", cleanup_done);
        return 1;
    }
    if (!WIFEXITED(last_status) || WEXITSTATUS(last_status) != 0) {
        printf("FAIL: child status=%d\n", last_status);
        return 1;
    }
    printf("PASS: K-03\n");
    return 0;
}
