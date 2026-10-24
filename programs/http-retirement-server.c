#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static void require(int condition, const char *operation) {
    if (!condition) { perror(operation); exit(1); }
}

static void write_all(int descriptor, const char *bytes, size_t length) {
    size_t offset = 0;
    while (offset < length) {
        ssize_t count = write(descriptor, bytes + offset, length - offset);
        require(count > 0, "write");
        offset += (size_t)count;
    }
}

static void report_memory(void) {
    int descriptor = open("/proc/kandelo/fs_memory", O_RDONLY);
    require(descriptor >= 0, "memory report open");
    puts("FS_MEMORY_BEGIN");
    fflush(stdout);
    char bytes[2048];
    for (;;) {
        ssize_t count = read(descriptor, bytes, sizeof(bytes));
        require(count >= 0, "memory report read");
        if (count == 0) break;
        write_all(STDOUT_FILENO, bytes, (size_t)count);
    }
    require(close(descriptor) == 0, "memory report close");
    puts("FS_MEMORY_END");
}

int main(int argc, char **argv) {
    require(argc == 2, "port argument");
    int listener = socket(AF_INET, SOCK_STREAM, 0);
    require(listener >= 0, "socket");
    struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = htons(atoi(argv[1])),
        .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    require(bind(listener, (struct sockaddr *)&address, sizeof(address)) == 0, "bind");
    require(listen(listener, 16) == 0, "listen");
    require(fcntl(listener, F_SETFL, O_NONBLOCK) == 0, "nonblocking listener");
    int accepted = -1;
    puts("RETIREMENT_READY");
    fflush(stdout);
    for (;;) {
        char command;
        ssize_t count = read(STDIN_FILENO, &command, 1);
        if (count < 0 && errno == EINTR) continue;
        require(count == 1, "command read");
        if (command == 'm') report_memory();
        else if (command == 'a') {
            require(accepted == -1, "accepted descriptor ownership");
            accepted = accept(listener, NULL, NULL);
            if (accepted < 0) { require(errno == EAGAIN, "accept"); puts("ACCEPT_EMPTY"); }
            else puts("ACCEPTED");
        } else if (command == 'v') {
            char byte;
            require(accepted >= 0, "reset descriptor ownership");
            require(recv(accepted, &byte, 1, MSG_DONTWAIT) == -1 && errno == ECONNRESET, "peer reset");
            require(close(accepted) == 0, "accepted close");
            accepted = -1;
            puts("PEER_RESET");
        } else if (command == 's') {
            const char response[] = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";
            require(accepted >= 0, "response descriptor ownership");
            write_all(accepted, response, sizeof(response) - 1);
            require(close(accepted) == 0, "response close");
            accepted = -1;
            puts("SERVED");
        } else if (command == 'q') break;
        else require(0, "unknown command");
        fflush(stdout);
    }
    if (accepted >= 0) require(close(accepted) == 0, "final accepted close");
    require(close(listener) == 0, "listener close");
    return 0;
}
