// fork-from-thread.c — fork() called on a non-main thread.
//
// A pthread_create'd worker thread invokes fork() directly. The child
// must inherit the worker thread's call stack as its sole thread and
// resume execution at the fork() call site with fork() returning 0.
// The parent thread resumes with the child's pid. The child then forks a
// grandchild before exec, so the inherited thread-function entry root and
// continuation buffer must be propagated across more than one generation.
//
// This exercises the host runtime's fork-from-non-main-thread path:
// the thread worker drives a wpk_fork unwind/SYS_FORK/rewind cycle,
// the kernel-worker passes the thread's fnPtr/argPtr through to onFork,
// and the child Worker enters the thread function directly instead of
// _start.
//
// Expected output on PASS:
//   THREAD_STARTED
//   PRE_FORK_THREAD
//   GRANDCHILD_THREAD: ok
//   CHILD_THREAD: grandchild=<pid>
//   PARENT_THREAD: child=<pid>
//   PASS

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
        pid_t grandchild = fork();
        if (grandchild < 0) {
            printf("FAIL: child fork errno=%d\n", errno);
            fflush(stdout);
            _exit(1);
        }
        if (grandchild == 0) {
            printf("GRANDCHILD_THREAD: ok\n");
            fflush(stdout);
            _exit(0);
        }
        int grandchild_status = 0;
        if (waitpid(grandchild, &grandchild_status, 0) < 0 ||
            !WIFEXITED(grandchild_status) || WEXITSTATUS(grandchild_status) != 0) {
            printf("FAIL: grandchild status=%d errno=%d\n", grandchild_status, errno);
            fflush(stdout);
            _exit(1);
        }
        printf("CHILD_THREAD: grandchild=%d\n", grandchild);
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
        printf("PASS\n");
        return 0;
    }
    printf("FAIL: child status=%d\n", status);
    return 1;
}
