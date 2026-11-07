#include <arpa/inet.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

#define CHECK(condition) do { if (!(condition)) { perror(#condition); return 1; } } while (0)

int main(int argc, char **argv) {
    CHECK(argc == 4);
    int family = strchr(argv[2], ':') ? AF_INET6 : AF_INET;
    struct sockaddr_storage address = {0};
    socklen_t length;
    if (family == AF_INET) {
        struct sockaddr_in *v4 = (struct sockaddr_in *)&address;
        v4->sin_family = AF_INET;
        v4->sin_port = htons(atoi(argv[1]));
        CHECK(inet_pton(AF_INET, argv[2], &v4->sin_addr) == 1);
        length = sizeof(*v4);
    } else {
        struct sockaddr_in6 *v6 = (struct sockaddr_in6 *)&address;
        v6->sin6_family = AF_INET6;
        v6->sin6_port = htons(atoi(argv[1]));
        CHECK(inet_pton(AF_INET6, argv[2], &v6->sin6_addr) == 1);
        length = sizeof(*v6);
    }
    int server = socket(family, SOCK_STREAM, 0);
    CHECK(server >= 0);
    CHECK(bind(server, (struct sockaddr *)&address, length) == 0);
    CHECK(listen(server, 1) == 0);
    puts("GUEST LISTENING");
    fflush(stdout);

    char release;
    CHECK(read(STDIN_FILENO, &release, 1) == 1);
    pid_t child = -1;
    if (strcmp(argv[3], "fork") == 0) {
        child = fork();
        CHECK(child >= 0);
        if (child == 0) CHECK(close(server) == 0);
    }
    if (family == AF_INET && ((struct sockaddr_in *)&address)->sin_addr.s_addr == INADDR_ANY)
        ((struct sockaddr_in *)&address)->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    const char message[] = "guest namespace";
    if (child <= 0) {
        int client = socket(family, SOCK_STREAM, 0);
        CHECK(client >= 0);
        CHECK(connect(client, (struct sockaddr *)&address, length) == 0);
        CHECK(write(client, message, sizeof(message)) == sizeof(message));
        CHECK(close(client) == 0);
        if (child == 0) _exit(0);
    }
    int accepted = accept(server, NULL, NULL);
    CHECK(accepted >= 0);
    char received[sizeof(message)];
    CHECK(read(accepted, received, sizeof(received)) == sizeof(received));
    CHECK(memcmp(message, received, sizeof(message)) == 0);
    CHECK(close(accepted) == 0);
    if (child > 0) {
        int status;
        CHECK(waitpid(child, &status, 0) == child);
        CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 0);
    }
    CHECK(close(server) == 0);
    puts("GUEST LOOPBACK PASS");
    return 0;
}
