/* Independent POSIX client for the JavaScript server's actual socket contract. */
#define _POSIX_C_SOURCE 200809L
#include <arpa/inet.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static void check(int ok, const char *operation) {
    if (!ok) { perror(operation); exit(1); }
}
int main(int argc, char **argv) {
    check(argc == 3, "arguments");
    alarm(20);
    int family = atoi(argv[1]) == 6 ? AF_INET6 : AF_INET;
    int fd = socket(family, SOCK_STREAM, 0);
    check(fd >= 0, "socket");
    struct sockaddr_storage address = {0};
    socklen_t length;
    if (family == AF_INET6) {
        struct sockaddr_in6 *v6 = (void *)&address;
        v6->sin6_family = family; v6->sin6_port = htons(atoi(argv[2]));
        check(inet_pton(family, "::1", &v6->sin6_addr) == 1, "inet_pton6");
        length = sizeof(*v6);
    } else {
        struct sockaddr_in *v4 = (void *)&address;
        v4->sin_family = family; v4->sin_port = htons(atoi(argv[2]));
        check(inet_pton(family, "127.0.0.1", &v4->sin_addr) == 1, "inet_pton4");
        length = sizeof(*v4);
    }
    check(connect(fd, (void *)&address, length) == 0, "connect");
    const char request[] = "independent-client";
    size_t sent = 0;
    while (sent < sizeof(request) - 1) {
        ssize_t n = write(fd, request + sent, sizeof(request) - 1 - sent);
        if (n < 0 && errno == EINTR) continue;
        check(n > 0, "write"); sent += n;
    }
    check(shutdown(fd, SHUT_WR) == 0, "shutdown");
    char reply[128]; size_t received = 0;
    for (;;) {
        ssize_t n = read(fd, reply + received, sizeof(reply) - received);
        if (n < 0 && errno == EINTR) continue;
        check(n >= 0, "read");
        if (n == 0) break;
        received += n; check(received < sizeof(reply), "reply size");
    }
    const char expected[] = "reply:independent-client";
    check(received == sizeof(expected) - 1 && memcmp(reply, expected, received) == 0, "reply bytes");
    check(close(fd) == 0, "close");
    puts("node-tcp-c-peer-ok");
    return 0;
}
