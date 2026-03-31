/*
 * fork-exec.c — Test program that forks, then the child execs.
 * The parent waits for the child and reports its exit status.
 */
#include <stdio.h>
#include <unistd.h>
#include <sys/wait.h>
#include <stdlib.h>

int main(void) {
    pid_t pid = fork();
    if (pid < 0) {
        perror("fork");
        return 1;
    }

    if (pid == 0) {
        /* Child — exec the child program */
        char *argv[] = {"exec-child", "from-fork", NULL};
        char *envp[] = {"FROM=fork", NULL};
        execve("/bin/exec-child", argv, envp);
        perror("execve");
        _exit(127);
    }

    /* Parent — wait for child */
    int status;
    if (waitpid(pid, &status, 0) < 0) {
        perror("waitpid");
        return 1;
    }

    if (WIFEXITED(status))
        printf("child exited with %d\n", WEXITSTATUS(status));
    else
        printf("child did not exit normally\n");

    return 0;
}
