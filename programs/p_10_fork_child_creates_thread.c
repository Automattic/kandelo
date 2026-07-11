// P-10 - fork child creates its first pthread.
//
// This covers the process-worker -> fork-child-worker -> pthread-worker path.
// The exported errno helper intentionally begins with a call returning an i32
// pointer. It mirrors large C runtimes such as Tcl, where treating the first
// exported call target as __wasm_call_ctors corrupts the thread module.

#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

__attribute__((export_name("p10_errno_address"), noinline))
int *p10_errno_address(void) {
    return &errno;
}

static void *child_thread(void *arg) {
    (void)arg;
    printf("CHILD_THREAD: ok\n");
    fflush(stdout);
    return (void *)(uintptr_t)42;
}

int main(void) {
    printf("PRE_FORK\n");
    fflush(stdout);

    pid_t pid = fork();
    if (pid < 0) {
        printf("FAIL: fork errno=%d\n", errno);
        return 1;
    }

    if (pid == 0) {
        pthread_t thread;
        int rc = pthread_create(&thread, NULL, child_thread, NULL);
        if (rc != 0) {
            printf("FAIL: child pthread_create rc=%d\n", rc);
            fflush(stdout);
            _exit(2);
        }

        void *result = NULL;
        rc = pthread_join(thread, &result);
        if (rc != 0 || (uintptr_t)result != 42) {
            printf("FAIL: child pthread_join rc=%d result=%lu\n",
                   rc, (unsigned long)(uintptr_t)result);
            fflush(stdout);
            _exit(3);
        }
        printf("CHILD: joined\n");
        fflush(stdout);
        _exit(0);
    }

    int status = 0;
    if (waitpid(pid, &status, 0) != pid) {
        printf("FAIL: waitpid errno=%d\n", errno);
        return 1;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        printf("FAIL: child status=%d\n", status);
        return 1;
    }

    printf("PASS: P-10\n");
    return 0;
}
