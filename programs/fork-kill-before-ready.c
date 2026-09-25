/*
 * A fork child killed before its replay reports ready is still the
 * parent's child.
 *
 * The test host sends SIGKILL to the child after the kernel created it and
 * before its Worker could replay to the fork site. POSIX gives the parent the
 * child's pid from fork() and a zombie it can reap with the kill status; it
 * must not see fork() fail or a child that never existed.
 */
#include <errno.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
    pid_t pid = fork();
    if (pid < 0) {
        printf("FORK_FAILED errno=%d\n", errno);
        return 1;
    }
    if (pid == 0) {
        printf("CHILD_RAN\n");
        _exit(7);
    }
    printf("PARENT_GOT_PID\n");
    int status = 0;
    if (waitpid(pid, &status, 0) != pid) {
        printf("WAITPID_FAILED errno=%d\n", errno);
        return 2;
    }
    if (!WIFSIGNALED(status) || WTERMSIG(status) != SIGKILL) {
        printf("WRONG_STATUS status=%d\n", status);
        return 3;
    }
    printf("PARENT_REAPED_SIGKILL\n");
    return 0;
}
