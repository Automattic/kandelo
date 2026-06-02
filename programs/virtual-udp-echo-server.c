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

    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) die("socket");

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons((uint16_t) atoi(argv[1]));
    if (bind(fd, (struct sockaddr*) &addr, sizeof(addr)) < 0) die("bind");

    char buf[256];
    struct sockaddr_in peer;
    socklen_t peer_len = sizeof(peer);
    ssize_t n = recvfrom(fd, buf, sizeof(buf), 0, (struct sockaddr*) &peer, &peer_len);
    if (n < 0) die("recvfrom");

    char out[320];
    int out_len = snprintf(out, sizeof(out), "echo:%.*s", (int) n, buf);
    if (out_len < 0 || out_len >= (int) sizeof(out)) {
        fprintf(stderr, "reply too large\n");
        return 1;
    }
    if (sendto(fd, out, (size_t) out_len, 0, (struct sockaddr*) &peer, peer_len) != out_len) {
        die("sendto");
    }

    close(fd);
    return 0;
}
