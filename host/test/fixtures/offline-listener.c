#define _POSIX_C_SOURCE 200809L
#include <arpa/inet.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) { perror("socket"); return 1; }
    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_port = htons((unsigned short)atoi(argv[1])),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    if (bind(fd, (void *)&addr, sizeof addr) || listen(fd, 4)) {
        perror("listen"); return 1;
    }
    puts("READY");
    fflush(stdout);
    char release;
    if (read(STDIN_FILENO, &release, 1) != 1) return 1;
    close(fd);
    return 0;
}
