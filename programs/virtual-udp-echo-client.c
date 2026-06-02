#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <poll.h>
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

    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) die("socket");

    struct sockaddr_in server;
    memset(&server, 0, sizeof(server));
    server.sin_family = AF_INET;
    server.sin_port = htons((uint16_t) atoi(argv[2]));
    if (inet_pton(AF_INET, argv[1], &server.sin_addr) != 1) die("inet_pton");

    const char* msg = argv[3];
    size_t msg_len = strlen(msg);
    char buf[320];
    struct pollfd pfd = { .fd = fd, .events = POLLIN, .revents = 0 };

    for (int attempt = 0; attempt < 25; attempt++) {
        ssize_t sent = sendto(fd, msg, msg_len, 0, (struct sockaddr*) &server, sizeof(server));
        if (sent < 0) die("sendto");
        if ((size_t) sent != msg_len) {
            fprintf(stderr, "short send\n");
            return 1;
        }

        pfd.revents = 0;
        int ready = poll(&pfd, 1, 100);
        if (ready < 0) {
            if (errno == EINTR) continue;
            die("poll");
        }
        if (ready == 0) continue;
        if (!(pfd.revents & POLLIN)) continue;

        struct sockaddr_in peer;
        socklen_t peer_len = sizeof(peer);
        ssize_t n = recvfrom(fd, buf, sizeof(buf) - 1, 0, (struct sockaddr*) &peer, &peer_len);
        if (n < 0) die("recvfrom");
        buf[n] = '\0';

        char peer_addr[INET_ADDRSTRLEN];
        if (!inet_ntop(AF_INET, &peer.sin_addr, peer_addr, sizeof(peer_addr))) die("inet_ntop");
        printf("%s %u %s\n", peer_addr, ntohs(peer.sin_port), buf);
        close(fd);
        return 0;
    }

    fprintf(stderr, "timed out waiting for udp reply\n");
    close(fd);
    return 1;
}
