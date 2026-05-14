// P-06 — fork() from a non-main thread (spawned via pthread_create).
//
// Coverage matrix: a fork-callable pattern not previously in the matrix.
// Tests whether the kernel's per-thread fork state machine handles
// fork-from-non-main-thread correctly. The kernel must:
//   - identify the calling thread (not main).
//   - copy that thread's wasm state for the child.
//   - the child resumes with the spawned thread as its initial thread.
//
// Expected output on PASS:
//   THREAD_STARTED
//   PRE_FORK_THREAD
//   CHILD_THREAD: ok
//   PARENT_THREAD: child=<pid>
//   PASS: P-06

#include <stdio.h>
#include <stdlib.h>
#include <pthread.h>
#include <unistd.h>
#include <sys/wait.h>
#include <errno.h>

static int child_pid_global = -1;

static void *forking_thread(void *arg) {
    (void)arg;
    printf("THREAD_STARTED\n");
    printf("PRE_FORK_THREAD\n");
    fflush(stdout);

    pid_t pid = fork();
    if (pid < 0) {
        printf("FAIL: fork errno=%d\n", errno);
        fflush(stdout);
        return NULL;
    }
    if (pid == 0) {
        printf("CHILD_THREAD: ok\n");
        fflush(stdout);
        _exit(0);
    }
    printf("PARENT_THREAD: child=%d\n", pid);
    fflush(stdout);
    child_pid_global = pid;
    return NULL;
}

int main(void) {
    pthread_t t;
    if (pthread_create(&t, NULL, forking_thread, NULL) != 0) {
        printf("FAIL: pthread_create\n");
        return 1;
    }
    pthread_join(t, NULL);

    if (child_pid_global < 0) {
        printf("FAIL: thread did not produce child pid\n");
        return 1;
    }
    int status = 0;
    if (waitpid(child_pid_global, &status, 0) < 0) {
        printf("FAIL: waitpid errno=%d\n", errno);
        return 1;
    }
    if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
        printf("PASS: P-06\n");
        return 0;
    }
    printf("FAIL: child status=%d\n", status);
    return 1;
}
