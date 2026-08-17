#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

extern char **environ;

int main(int argc, char **argv)
{
    if (argc < 2) {
        fputs("exec-argv: missing executable\n", stderr);
        return 2;
    }

    execve(argv[1], &argv[1], environ);
    int exec_errno = errno;
    fprintf(stderr, "exec-argv: execve: %s\n", strerror(exec_errno));
    return exec_errno == ENOENT ? 127 : 126;
}
