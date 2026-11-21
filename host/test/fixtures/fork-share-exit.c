#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static char data[1 << 16];
static volatile unsigned spin;

static int forks_after(const char *label) {
    memset(data, 0x11, sizeof data);
    pid_t child = fork();
    if (child < 0) { printf("%s fork=-1\n", label); return 0; }
    if (child == 0) {
        int ok = data[100] == 0x11;
        memset(data, 0x22, sizeof data);
        _exit(ok ? 7 : 8);
    }
    int status = -1;
    waitpid(child, &status, 0);
    int ok = WIFEXITED(status) && WEXITSTATUS(status) == 7 && data[100] == 0x11;
    printf("%s fork-after=%d\n", label, ok);
    return ok;
}

int main(void) {
    int ok = 1;

    pid_t blocked = fork();
    if (blocked == 0) { for (;;) pause(); }
    kill(blocked, SIGKILL);
    int status = -1;
    waitpid(blocked, &status, 0);
    printf("blocked signaled=%d sig=%d\n", WIFSIGNALED(status), WTERMSIG(status));
    ok &= WIFSIGNALED(status) && WTERMSIG(status) == SIGKILL;
    ok &= forks_after("blocked");

    pid_t running = fork();
    if (running == 0) { for (;;) spin++; }
    usleep(200000);
    kill(running, SIGKILL);
    status = -1;
    waitpid(running, &status, 0);
    printf("running signaled=%d sig=%d\n", WIFSIGNALED(status), WTERMSIG(status));
    ok &= WIFSIGNALED(status) && WTERMSIG(status) == SIGKILL;
    ok &= forks_after("running");

    int fds[2];
    pipe(fds);
    pid_t middle = fork();
    if (middle == 0) {
        memset(data, 0x33, sizeof data);
        pid_t orphan = fork();
        if (orphan == 0) {
            close(fds[0]);
            usleep(300000);
            char byte = data[200] == 0x33 ? 'k' : 'x';
            memset(data, 0x44, sizeof data);
            write(fds[1], &byte, 1);
            _exit(0);
        }
        _exit(5);
    }
    close(fds[1]);
    status = -1;
    waitpid(middle, &status, 0);
    char byte = 0;
    read(fds[0], &byte, 1);
    printf("orphan middle=%d byte=%c kept=%d\n", WEXITSTATUS(status), byte, data[200] == 0x11);
    ok &= WEXITSTATUS(status) == 5 && byte == 'k' && data[200] == 0x11;
    ok &= forks_after("orphan");

    int reaped = 0;
    for (int i = 0; i < 40; i++) {
        pid_t child = fork();
        if (child == 0) { data[i] = (char)i; _exit(i); }
        status = -1;
        waitpid(child, &status, 0);
        reaped += WIFEXITED(status) && WEXITSTATUS(status) == i && data[i] == 0x11;
    }
    printf("loop reaped=%d\n", reaped);
    ok &= reaped == 40;
    return !ok;
}
