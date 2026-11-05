#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <unistd.h>

#define CHECK(x) do { if (!(x)) { perror(#x); return 1; } } while (0)

int main(int argc, char **argv) {
    int card = open("/dev/dri/card0", O_RDWR);
    CHECK(card >= 0);
    CHECK(ioctl(card, 0x641e, 0) == 0);
    pid_t child = fork();
    CHECK(child >= 0);
    if (child == 0) _exit(0);
    int status;
    CHECK(waitpid(child, &status, 0) == child);
    CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 0);
    puts("owner retained after child exit");
    fflush(stdout);
    char byte;
    CHECK(read(STDIN_FILENO, &byte, 1) == 1);
    if (argc > 1 && strcmp(argv[1], "drop") == 0) {
        CHECK(ioctl(card, 0x641f, 0) == 0);
        puts("master released while process lives");
        fflush(stdout);
        CHECK(read(STDIN_FILENO, &byte, 1) == 1);
    }
    return 0;
}
