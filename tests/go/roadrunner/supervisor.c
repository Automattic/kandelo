#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

static int request(void) {
    struct sockaddr_in address = {
        .sin_family = AF_INET,
        .sin_port = htons(18080),
        .sin_addr.s_addr = htonl(INADDR_LOOPBACK),
    };
    int socket_fd = -1;
    for (int attempt = 0; attempt < 100; attempt++) {
        socket_fd = socket(AF_INET, SOCK_STREAM, 0);
        if (socket_fd < 0) {
            return -1;
        }
        if (connect(socket_fd, (struct sockaddr *)&address, sizeof(address)) == 0) {
            break;
        }
        close(socket_fd);
        socket_fd = -1;
        struct timespec delay = {.tv_sec = 0, .tv_nsec = 100000000};
        nanosleep(&delay, NULL);
    }
    if (socket_fd < 0) {
        return -1;
    }

    struct timeval timeout = {.tv_sec = 10, .tv_usec = 0};
    if (setsockopt(socket_fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) != 0) {
        close(socket_fd);
        return -1;
    }
    const char *request_bytes =
        "GET /probe HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    size_t remaining = strlen(request_bytes);
    while (remaining > 0) {
        ssize_t written = send(socket_fd, request_bytes, remaining, 0);
        if (written <= 0) {
            close(socket_fd);
            return -1;
        }
        request_bytes += written;
        remaining -= (size_t)written;
    }

    char response[16384];
    size_t received = 0;
    while (received < sizeof(response) - 1) {
        ssize_t count = recv(socket_fd, response + received,
                             sizeof(response) - received - 1, 0);
        if (count < 0) {
            close(socket_fd);
            return -1;
        }
        if (count == 0) {
            break;
        }
        received += (size_t)count;
        response[received] = '\0';
        if (strstr(response, "ROADRUNNER PHP PASS") != NULL) {
            break;
        }
    }
    close(socket_fd);
    response[received] = '\0';
    if (strncmp(response, "HTTP/1.1 200", 12) != 0 ||
        strstr(response, "ROADRUNNER PHP PASS") == NULL) {
        fprintf(stderr, "unexpected RoadRunner response: %s\n", response);
        return -1;
    }
    return 0;
}

int main(void) {
    if (setenv("GOMAXPROCS", "2", 1) != 0) {
        return 1;
    }
    char *argv[] = {"/bin/roadrunner.wasm", "/etc/rr.yaml", NULL};
    pid_t server_pid;
    int error = posix_spawn(&server_pid, argv[0], NULL, NULL, argv, environ);
    if (error != 0) {
        fprintf(stderr, "RoadRunner spawn failed: %d\n", error);
        return 1;
    }

    int result = request();
    if (result != 0) {
        fprintf(stderr, "RoadRunner request failed: %d\n", errno);
    }
    kill(server_pid, SIGTERM);
    int status;
    if (waitpid(server_pid, &status, 0) != server_pid) {
        fprintf(stderr, "RoadRunner wait failed: %d\n", errno);
        return 1;
    }
    if (result != 0) {
        return 1;
    }
    puts("ROADRUNNER ROUND TRIP PASS");
    return 0;
}
