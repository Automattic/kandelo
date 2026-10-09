#include <spawn.h>
#include <stdio.h>
#include <sys/wait.h>

extern char **environ;

int main(void) {
    const char *path = "/bin/go-hello.wasm";
    char *argv[] = {"go-hello", "package", NULL};
    pid_t child;
    int error = posix_spawn(&child, path, NULL, NULL, argv, environ);
    if (error != 0) {
        fprintf(stderr, "go package spawn failed: %d\n", error);
        return 1;
    }
    int status = 0;
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "go package child failed: %d\n", status);
        return 1;
    }
    puts("GO PACKAGE LAUNCH PASS");
    return 0;
}
