#include <signal.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

/* Keep a process group alive after its leader's parent consumes the exit. */
int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    pid_t leader = fork();
    if (leader < 0) return 1;
    if (leader == 0) {
        if (setpgid(0, 0) < 0) _exit(2);
        pid_t member = fork();
        if (member < 0) _exit(3);
        if (member > 0) printf("LEADER=%d MEMBER=%d\n", getpid(), member);
        for (;;) pause();
    }
    int status;
    if (waitpid(leader, &status, 0) != leader) return 4;
    if (!WIFSIGNALED(status) || WTERMSIG(status) != SIGTERM) return 5;
    printf("LEADER_REAPED=%d\n", leader);
    for (;;) pause();
}
