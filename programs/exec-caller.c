/*
 * exec-caller.c — Test program that calls execve to replace itself.
 * Used by the exec integration test.
 */
#include <unistd.h>
#include <stdio.h>

extern char **environ;

int main(void) {
    char *argv[] = {"exec-child", "hello", "world", NULL};
    char *envp[] = {"FOO=bar", "TEST=exec", NULL};
    execve("/bin/exec-child", argv, envp);
    /* If we get here, exec failed */
    perror("execve");
    return 127;
}
