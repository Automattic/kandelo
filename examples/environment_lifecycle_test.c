#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

static int kernel_env_equals(const char *name, const char *expected)
{
    char buf[256];
    errno = 0;
    long len = syscall(SYS_getenv, name, buf, sizeof(buf));
    if (expected == NULL)
        return len == -1 && errno == ENOENT;
    size_t expected_len = strlen(expected);
    return len == (long)expected_len &&
        memcmp(buf, expected, expected_len) == 0;
}

static int environment_equals(const char *name, const char *expected)
{
    const char *value = getenv(name);
    if (expected == NULL) {
        if (value != NULL)
            return 0;
    } else if (value == NULL || strcmp(value, expected) != 0) {
        return 0;
    }
    return kernel_env_equals(name, expected);
}

static int exec_replacement(void)
{
    if (!environment_equals("REPLACED", "exec") ||
        !environment_equals("INITIAL", NULL) ||
        !environment_equals("MUTATED", NULL) ||
        !environment_equals("REMOVE", NULL)) {
        fprintf(stderr, "exec environment was merged instead of replaced\n");
        return 20;
    }
    puts("EXEC_ENV_PASS");
    fflush(stdout);

    char *argv[] = { "/bin/environment-lifecycle", "empty", NULL };
    char *envp[] = { NULL };
    execve(argv[0], argv, envp);
    perror("execve empty environment");
    return 21;
}

static int empty_replacement(void)
{
    if (!environment_equals("REPLACED", NULL) ||
        !environment_equals("INITIAL", NULL) ||
        !environment_equals("MUTATED", NULL) ||
        !environment_equals("REMOVE", NULL)) {
        fprintf(stderr, "empty exec environment retained an old entry\n");
        return 30;
    }
    puts("EMPTY_ENV_PASS");
    return 0;
}

int main(int argc, char **argv)
{
    if (argc == 2 && strcmp(argv[1], "exec") == 0)
        return exec_replacement();
    if (argc == 2 && strcmp(argv[1], "empty") == 0)
        return empty_replacement();

    if (!environment_equals("INITIAL", "parent") ||
        !environment_equals("REMOVE", "before-fork")) {
        fprintf(stderr, "initial guest and kernel environments diverged\n");
        return 1;
    }
    if (setenv("MUTATED", "before-fork", 1) != 0 || unsetenv("REMOVE") != 0) {
        perror("prepare fork environment");
        return 2;
    }

    int gate[2];
    if (pipe(gate) != 0) {
        perror("pipe");
        return 3;
    }
    pid_t pid = fork();
    if (pid < 0) {
        perror("fork");
        return 4;
    }
    if (pid == 0) {
        close(gate[1]);
        char byte;
        if (read(gate[0], &byte, 1) != 1) {
            perror("child gate read");
            _exit(10);
        }
        close(gate[0]);
        if (!environment_equals("INITIAL", "parent") ||
            !environment_equals("MUTATED", "before-fork") ||
            !environment_equals("REMOVE", NULL)) {
            fprintf(stderr, "fork child environment was not an isolated copy\n");
            _exit(11);
        }
        puts("FORK_ENV_PASS");
        fflush(stdout);
        _exit(0);
    }

    close(gate[0]);
    if (setenv("MUTATED", "parent-after-fork", 1) != 0) {
        perror("parent setenv");
        return 5;
    }
    if (write(gate[1], "x", 1) != 1) {
        perror("parent gate write");
        return 6;
    }
    close(gate[1]);

    int status = 0;
    if (waitpid(pid, &status, 0) != pid || !WIFEXITED(status) ||
        WEXITSTATUS(status) != 0) {
        fprintf(stderr, "fork child failed: status=%d\n", status);
        return 7;
    }

    char *exec_argv[] = { "/bin/environment-lifecycle", "exec", NULL };
    char *exec_envp[] = { "REPLACED=exec", NULL };
    execve(exec_argv[0], exec_argv, exec_envp);
    perror("execve replacement environment");
    return 8;
}
