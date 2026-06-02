#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static void die(const char* what) {
    perror(what);
    exit(1);
}

int main(int argc, char** argv) {
    if (argc != 4) {
        fprintf(stderr, "usage: %s ADDRESS PORT MESSAGE\n", argv[0]);
        return 2;
    }

    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) die("socket");

    struct sockaddr_in server;
    memset(&server, 0, sizeof(server));
    server.sin_family = AF_INET;
    server.sin_port = htons((uint16_t) atoi(argv[2]));
    if (inet_pton(AF_INET, argv[1], &server.sin_addr) != 1) die("inet_pton");
    if (connect(fd, (struct sockaddr*) &server, sizeof(server)) < 0) die("connect");

    const char* msg = argv[3];
    size_t msg_len = strlen(msg);
    if (write(fd, msg, msg_len) != (ssize_t) msg_len) die("write");

    char buf[320];
    ssize_t n = read(fd, buf, sizeof(buf) - 1);
    if (n < 0) die("read");
    buf[n] = '\0';
    printf("%s\n", buf);

    close(fd);
    return 0;
}
