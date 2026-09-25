/*
 * An ordinary fork() returns in the parent while the child is still running.
 *
 * The child blocks until the parent writes to a pipe, so the parent must get
 * the child pid back from fork() before the child can exit. A host or kernel
 * that completes the parent only when the child ends deadlocks here.
 */
#include <errno.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
    int fds[2];
    if (pipe(fds) != 0) return 1;
    pid_t pid = fork();
    if (pid < 0) {
        printf("FORK_FAILED errno=%d\n", errno);
        return 2;
    }
    if (pid == 0) {
        char byte = 0;
        close(fds[1]);
        if (read(fds[0], &byte, 1) != 1) _exit(3);
        _exit(byte == 'x' ? 0 : 4);
    }
    close(fds[0]);
    printf("PARENT_RETURNED_FROM_FORK\n");
    fflush(stdout);
    if (write(fds[1], "x", 1) != 1) return 5;
    int status = 0;
    if (waitpid(pid, &status, 0) != pid) return 6;
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        printf("CHILD_STATUS status=%d\n", status);
        return 7;
    }
    printf("CHILD_EXITED_AFTER_PARENT\n");
    return 0;
}
