// P-08 — vfork(): the parent resumes after the child's _exit().
//
// ABI 43 gives vfork a distinct transaction. The child Worker borrows the
// parent's address space without allocating/copying a process Memory, and the
// calling parent thread remains parked until exec or _exit. Keep the child in
// the portable pre-exec subset: it calls only _exit().
//
// Expected output on PASS (vfork supported):
//   PRE_VFORK
//   PARENT: child=<pid>
//   PASS: P-08

#include <stdio.h>
#include <unistd.h>
#include <sys/wait.h>
#include <errno.h>

int main(void) {
    printf("PRE_VFORK\n");
    fflush(stdout);

    pid_t pid = vfork();
    if (pid < 0) {
        printf("FAIL: vfork errno=%d\n", errno);
        return 1;
    }
    if (pid == 0) {
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
