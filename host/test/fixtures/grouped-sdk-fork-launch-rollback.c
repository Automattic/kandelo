#include <errno.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>
#define CHECK(x) do { if (!(x)) { fprintf(stderr,"fork-rollback:%d errno=%d\n",__LINE__,errno); return 1; } } while(0)
static volatile int unchanged = 37;
int main(void) {
    const pid_t original = getpid();
    for (int attempt = 0; attempt < 16; attempt++) {
        errno = 0;
        CHECK(fork() == -1 && errno == ENOMEM);
        CHECK(getpid() == original && unchanged == 37);
        errno = 0;
        CHECK(waitpid(-1, NULL, WNOHANG) == -1 && errno == ECHILD);
    }
    const pid_t child = fork();
    CHECK(child >= 0);
    if (!child) { unchanged = 42; _exit(23); }
    int status;
    CHECK(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 23);
    CHECK(unchanged == 37);
    puts("grouped-sdk-fork-launch-rollback PASS 16");
    return 0;
}
