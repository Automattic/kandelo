#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static char data[1 << 16];

int main(int argc, char **argv) {
    if (argc > 2 && strcmp(argv[2], "stage2") == 0) {
        int status = -1;
        pid_t child = waitpid(-1, &status, 0);
        int fresh = data[300] == 0;
        pid_t next = fork();
        if (next == 0) _exit(data[300] == 0 ? 6 : 9);
        int other = -1;
        waitpid(next, &other, 0);
        printf("stage2 child=%d status=%d fresh=%d next=%d\n",
            child > 0, WEXITSTATUS(status), fresh, WEXITSTATUS(other));
        return !(child > 0 && WEXITSTATUS(status) == 3 && fresh && WEXITSTATUS(other) == 6);
    }
    memset(data, 0x11, sizeof data);
    pid_t child = fork();
    if (child == 0) {
        usleep(300000);
        int ok = data[300] == 0x11;
        memset(data, 0x22, sizeof data);
        usleep(100000);
        _exit(ok && data[300] == 0x22 ? 3 : 4);
    }
    chmod(argv[1], 0755);
    execl(argv[1], argv[1], argv[1], "stage2", (char *)NULL);
    perror("execl");
    return 1;
}
