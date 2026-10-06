#include <arpa/inet.h>
#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>

static int available(int fd, int expected) {
    int count = -1;
    if (ioctl(fd, FIONREAD, &count) != 0) { perror("FIONREAD"); return 1; }
    if (count != expected) {
        fprintf(stderr, "FIONREAD reported %d, expected first datagram size %d\n", count, expected);
        return 1;
    }
    return 0;
}

int main(int argc, char **argv) {
    int receiver = socket(AF_INET, SOCK_DGRAM, 0);
    if (receiver < 0) { perror("socket"); return 1; }
    struct sockaddr_in local = { .sin_family = AF_INET };
    if (argc == 3 && !strcmp(argv[1], "server")) local.sin_port = htons(9001);
    socklen_t len = sizeof(local);
    if (bind(receiver, (struct sockaddr *)&local, sizeof(local)) != 0) { perror("bind"); return 1; }

    if ((argc == 3 || argc == 4) && (!strcmp(argv[1], "server") || !strcmp(argv[1], "client"))) {
        int server = !strcmp(argv[1], "server");
        struct sockaddr_in peer = { .sin_family = AF_INET, .sin_port = htons(9001) };
        struct in_addr expected;
        if (inet_pton(AF_INET, argv[2], &expected) != 1) return 2;
        peer.sin_addr = expected;
        if (!server && argc == 4) {
            size_t size = (size_t)strtoul(argv[3], NULL, 10) + 1;
            char *oversized = calloc(size, 1);
            if (!oversized) return 1;
            ssize_t sent = sendto(receiver, oversized, size, 0, (struct sockaddr *)&peer, sizeof(peer));
            int send_errno = errno;
            free(oversized);
            if (sent != -1 || send_errno != EMSGSIZE) {
                fprintf(stderr, "negotiated UDP payload cap: expected EMSGSIZE, got %d\n", send_errno); return 1;
            }
        }
        if (!server && sendto(receiver, "hello", 5, 0, (struct sockaddr *)&peer, sizeof(peer)) != 5) {
            perror("sendto"); return 1;
        }
        struct pollfd ready = { .fd = receiver, .events = POLLIN };
        if (poll(&ready, 1, 10000) != 1) { fprintf(stderr, "remote UDP receive timed out\n"); return 1; }
        char data[16]; socklen_t peer_len = sizeof(peer);
        if (recvfrom(receiver, data, sizeof(data), 0, (struct sockaddr *)&peer, &peer_len) != 5
            || memcmp(data, server ? "hello" : "reply", 5)
            || peer.sin_addr.s_addr != expected.s_addr) {
            fprintf(stderr, "remote UDP payload or source mismatch\n"); return 1;
        }
        if (server && sendto(receiver, "reply", 5, 0, (struct sockaddr *)&peer, peer_len) != 5) {
            perror("reply"); return 1;
        }
        close(receiver); puts(server ? "received hello and replied" : "received remote reply"); return 0;
    }

    if (argc == 2 && !strcmp(argv[1], "errors")) {
        struct sockaddr_in remote = { .sin_family = AF_INET, .sin_port = htons(9000) };
        inet_pton(AF_INET, "10.89.0.99", &remote.sin_addr);
        if (sendto(receiver, "x", 1, 0, (struct sockaddr *)&remote, sizeof(remote)) != -1 || errno != EHOSTUNREACH) {
            fprintf(stderr, "unknown UDP destination: expected EHOSTUNREACH, got %d\n", errno); return 1;
        }
        inet_pton(AF_INET, "10.89.0.1", &remote.sin_addr);
        if (sendto(receiver, "x", 1, 0, (struct sockaddr *)&remote, sizeof(remote)) != -1 || errno != ECONNREFUSED) {
            fprintf(stderr, "unbound UDP destination: expected ECONNREFUSED, got %d\n", errno); return 1;
        }
        int sockets[32];
        for (int i = 0; i < 32; i++) {
            sockets[i] = socket(AF_INET, SOCK_DGRAM, 0);
            if (sockets[i] < 0) return 1;
            int bound = bind(sockets[i], (struct sockaddr *)&local, sizeof(local));
            if (i == 31) {
                if (bound != -1 || errno != ENOBUFS) {
                    fprintf(stderr, "UDP binding cap: expected ENOBUFS, got %d\n", errno); return 1;
                }
            } else if (bound != 0) { perror("bind below cap"); return 1; }
        }
        for (int i = 0; i < 32; i++) close(sockets[i]);
        close(receiver);
        puts("UDP preserves unreachable, refused, and buffer exhaustion errnos");
        return 0;
    }

    if (argc == 4 && !strcmp(argv[1], "route")) {
        struct sockaddr_in remote = { .sin_family = AF_INET, .sin_port = htons(9000) };
        struct in_addr expected;
        if (inet_pton(AF_INET, argv[2], &remote.sin_addr) != 1 || inet_pton(AF_INET, argv[3], &expected) != 1) return 2;
        if (connect(receiver, (struct sockaddr *)&remote, sizeof(remote)) != 0) { perror("connect"); return 1; }
        if (getsockname(receiver, (struct sockaddr *)&local, &len) != 0) { perror("getsockname"); return 1; }
        if (local.sin_addr.s_addr != expected.s_addr) {
            fprintf(stderr, "connected UDP selected %s, expected %s\n", inet_ntoa(local.sin_addr), argv[3]);
            return 1;
        }
        struct sockaddr disconnect = { .sa_family = AF_UNSPEC };
        if (connect(receiver, &disconnect, sizeof(disconnect)) != 0) { perror("disconnect"); return 1; }
        len = sizeof(local);
        if (getsockname(receiver, (struct sockaddr *)&local, &len) != 0) return 1;
        if (local.sin_addr.s_addr != INADDR_ANY) {
            fprintf(stderr, "disconnect did not restore the wildcard binding\n"); return 1;
        }
        close(receiver);
        puts("connected UDP source and wildcard disconnect are coherent");
        return 0;
    }

    if (getsockname(receiver, (struct sockaddr *)&local, &len) != 0) return 1;
    local.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    int sender = socket(AF_INET, SOCK_DGRAM, 0);
    if (sender < 0) return 1;
    if (available(receiver, 0)) return 1;
    if (sendto(sender, "first", 5, 0, (struct sockaddr *)&local, sizeof(local)) != 5) return 1;
    if (sendto(sender, "secondone", 9, 0, (struct sockaddr *)&local, sizeof(local)) != 9) return 1;
    struct pollfd readable = { .fd = receiver, .events = POLLIN };
    if (poll(&readable, 1, 2000) != 1 || !(readable.revents & POLLIN)) return 1;
    if (available(receiver, 5)) return 1;
    char data[16];
    if (recv(receiver, data, sizeof(data), MSG_PEEK) != 5 || memcmp(data, "first", 5)) return 1;
    if (available(receiver, 5)) return 1;
    if (recv(receiver, data, sizeof(data), 0) != 5 || memcmp(data, "first", 5)) return 1;
    if (available(receiver, 9)) return 1;
    if (recv(receiver, data, 4, 0) != 4 || memcmp(data, "seco", 4)) return 1;
    if (available(receiver, 0)) return 1;
    if (sendto(sender, "", 0, 0, (struct sockaddr *)&local, sizeof(local)) != 0) return 1;
    if (sendto(sender, "ok", 2, 0, (struct sockaddr *)&local, sizeof(local)) != 2) return 1;
    if (available(receiver, 0)) return 1;
    if (recv(receiver, data, sizeof(data), 0) != 0) return 1;
    if (available(receiver, 2)) return 1;
    if (recv(receiver, data, sizeof(data), 0) != 2 || memcmp(data, "ok", 2)) return 1;
    if (available(receiver, 0)) return 1;
    close(sender); close(receiver);
    puts("FIONREAD reports the next datagram without consuming it");
    return 0;
}
