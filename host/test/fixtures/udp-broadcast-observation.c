/*
 * LAN discovery the way games do it: one program announces to the limited
 * broadcast address, others listen on a wildcard socket.
 *
 *   udp-broadcast-observation listen PORT COUNT
 *   udp-broadcast-observation announce PORT PAYLOAD [ADDRESS]
 *
 * ADDRESS defaults to the limited broadcast address; pass the interface's
 * subnet broadcast address to test a directed broadcast.
 */
#include <arpa/inet.h>
#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 4 && !(argc == 5 && !strcmp(argv[1], "announce"))) return 2;
    int port = atoi(argv[2]);
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) { perror("socket"); return 1; }
    struct sockaddr_in addr = { .sin_family = AF_INET, .sin_port = htons(port) };

    if (!strcmp(argv[1], "listen")) {
        if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) { perror("bind"); return 1; }
        printf("listening on %d\n", port);
        fflush(stdout);
        for (int count = atoi(argv[3]); count > 0; count--) {
            struct pollfd ready = { .fd = fd, .events = POLLIN };
            if (poll(&ready, 1, 10000) != 1) { fprintf(stderr, "no broadcast arrived\n"); return 1; }
            char data[64]; struct sockaddr_in from; socklen_t from_len = sizeof(from);
            ssize_t n = recvfrom(fd, data, sizeof(data) - 1, 0, (struct sockaddr *)&from, &from_len);
            if (n < 0) { perror("recvfrom"); return 1; }
            data[n] = 0;
            printf("heard %s from %s\n", data, inet_ntoa(from.sin_addr));
        }
        return 0;
    }

    if (!strcmp(argv[1], "announce")) {
        addr.sin_addr.s_addr = htonl(INADDR_BROADCAST);
        if (argc == 5 && inet_pton(AF_INET, argv[4], &addr.sin_addr) != 1) return 2;
        size_t len = strlen(argv[3]);
        // POSIX: sending to a broadcast address needs SO_BROADCAST first.
        if (sendto(fd, argv[3], len, 0, (struct sockaddr *)&addr, sizeof(addr)) != -1 || errno != EACCES) {
            fprintf(stderr, "broadcast without SO_BROADCAST: expected EACCES, got %d\n", errno); return 1;
        }
        int on = 1;
        if (setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &on, sizeof(on)) != 0) { perror("SO_BROADCAST"); return 1; }
        if (sendto(fd, argv[3], len, 0, (struct sockaddr *)&addr, sizeof(addr)) != (ssize_t)len) { perror("sendto"); return 1; }
        printf("announced\n");
        return 0;
    }
    return 2;
}
