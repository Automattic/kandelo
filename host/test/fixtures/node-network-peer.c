/* A real POSIX listener for Node client tests. The current JS Server is partial,
 * so using it as the peer would hide failures behind its listening event. */
#define _POSIX_C_SOURCE 200809L
#include <arpa/inet.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static void check(int ok, const char *name) {
    if (!ok) { perror(name); exit(1); }
}
int main(void) {
    alarm(30);
    int listener = socket(AF_INET6, SOCK_STREAM, 0);
    check(listener >= 0, "socket");
    struct sockaddr_in6 local = { .sin6_family = AF_INET6 };
    check(inet_pton(AF_INET6, "::1", &local.sin6_addr) == 1, "inet_pton");
    check(bind(listener, (void *)&local, sizeof(local)) == 0, "bind");
    check(listen(listener, 8) == 0, "listen");
    socklen_t length = sizeof(local);
    check(getsockname(listener, (void *)&local, &length) == 0, "getsockname");
    printf("PORT:%u\n", ntohs(local.sin6_port));
    fflush(stdout);
    for (int i = 0; i < 4; i++) {
        int client = accept(listener, NULL, NULL);
        check(client >= 0, "accept");
        char data[128];
        size_t count = 0;
        while (count < sizeof(data)) {
            ssize_t n = read(client, data + count, sizeof(data) - count);
            if (n < 0 && errno == EINTR) continue;
            check(n > 0, "read");
            count += (size_t)n;
            if (memchr(data, '\n', count)) break;
        }
        size_t sent = 0;
        while (sent < count) {
            ssize_t n = write(client, data + sent, count - sent);
            if (n < 0 && errno == EINTR) continue;
            check(n > 0, "write");
            sent += (size_t)n;
        }
        check(close(client) == 0, "close");
    }
    check(close(listener) == 0, "listener close");
    puts("node-network-peer-ok");
    return 0;
}
