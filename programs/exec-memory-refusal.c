#include <errno.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void)
{
    pid_t original = getpid();
    char *arguments[] = { "/bin/large", NULL };
    char *environment[] = { NULL };
    if (fcntl(STDOUT_FILENO, F_SETFD, FD_CLOEXEC) < 0) return 1;
    if (execve(arguments[0], arguments, environment) != -1) return 2;
    int failure = errno;
    printf("EXEC_REFUSAL_ERRNO=%d\n", failure);
    if (failure != ENOMEM || getpid() != original) return 3;
    if (fcntl(STDOUT_FILENO, F_GETFD) != FD_CLOEXEC) return 4;
    arguments[0] = "/bin/small";
    pid_t child;
    failure = posix_spawn(&child, arguments[0], NULL, NULL, arguments, environment);
    if (failure != 0) {
        fprintf(stderr, "spawn: %d\n", failure);
        return 5;
    }
    int status;
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status) != 42) return 6;
    puts("EXEC_REFUSAL_OLD_IMAGE_AND_NEXT_LAUNCH_OK");
    return 0;
}
