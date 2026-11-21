#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static char path[32];
static char text[32];
static char *argv[4];

int main(void) {
    memset(text, 0x55, sizeof text);
    pid_t child = fork();
    if (child == 0) {
        strcpy(path, "/bin/sh");
        strcpy(text, "exit 41");
        argv[0] = "sh"; argv[1] = "-c"; argv[2] = text; argv[3] = NULL;
        execv(path, argv);
        _exit(1);
    }
    strcpy(path, "/nonexistent");
    strcpy(text, "exit 9");
    int status = -1;
    waitpid(child, &status, 0);
    char *again = text;
    pid_t second = fork();
    if (second == 0) {
        strcpy(text, "exit 43");
        execl("/bin/sh", "sh", "-c", again, (char *)NULL);
        _exit(1);
    }
    int other = -1;
    waitpid(second, &other, 0);
    printf("parent first=%d second=%d\n", WEXITSTATUS(status), WEXITSTATUS(other));
    return !(WEXITSTATUS(status) == 41 && WEXITSTATUS(other) == 43);
}
