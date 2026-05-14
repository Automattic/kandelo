// P-08 — vfork(): if libc supports it, behavior should be parity
// with fork() for our kernel (which doesn't distinguish them).
//
// Coverage matrix: vfork() is a POSIX optimization where the child
// shares the parent's address space until exec/exit. Our kernel
// uses copy-on-write effectively, so vfork can degrade to fork.
// musl's vfork implementation typically aliases fork.
//
// If vfork is unsupported (returns -1 with ENOSYS), test passes
// trivially (marker: SKIP_VFORK).
//
// Expected output on PASS (vfork supported):
//   PRE_VFORK
//   CHILD: ok
//   PARENT: child=<pid>
//   PASS: P-08
//
// Expected output on PASS (vfork unsupported):
//   PRE_VFORK
//   SKIP_VFORK errno=...
//   PASS: P-08

#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/wait.h>
#include <errno.h>

int main(void) {
    printf("PRE_VFORK\n");
    fflush(stdout);

    pid_t pid = vfork();
    if (pid < 0) {
        if (errno == ENOSYS) {
            printf("SKIP_VFORK errno=%d\n", errno);
            printf("PASS: P-08\n");
            return 0;
        }
        printf("FAIL: vfork errno=%d\n", errno);
        return 1;
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
        printf("FAIL: waitpid errno=%d\n", errno);
        return 1;
    }
    if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
        printf("PASS: P-08\n");
        return 0;
    }
    printf("FAIL: child status=%d\n", status);
    return 1;
}
