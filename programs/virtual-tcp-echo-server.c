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
    if (argc != 2) {
        fprintf(stderr, "usage: %s PORT\n", argv[0]);
        return 2;
    }

    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) die("socket");

    int one = 1;
    if (setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one)) < 0) die("setsockopt");

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons((uint16_t) atoi(argv[1]));
    if (bind(fd, (struct sockaddr*) &addr, sizeof(addr)) < 0) die("bind");
    if (listen(fd, 8) < 0) die("listen");

    struct sockaddr_in peer;
    socklen_t peer_len = sizeof(peer);
    int conn = accept(fd, (struct sockaddr*) &peer, &peer_len);
    if (conn < 0) die("accept");

    char buf[256];
    ssize_t n = read(conn, buf, sizeof(buf));
    if (n < 0) die("read");

    char out[320];
    int out_len = snprintf(out, sizeof(out), "echo:%.*s", (int) n, buf);
    if (out_len < 0 || out_len >= (int) sizeof(out)) {
        fprintf(stderr, "reply too large\n");
        return 1;
    }
    if (write(conn, out, (size_t) out_len) != out_len) die("write");

    close(conn);
    close(fd);
    return 0;
}
