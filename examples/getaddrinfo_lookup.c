/*
 * getaddrinfo_lookup NAME... — resolve each NAME as AF_INET and print the
 * outcome on its own line:
 *
 *   NAME ok A.B.C.D
 *   NAME error <EAI code> <gai_strerror text>
 *
 * Tests use it to observe which getaddrinfo(3) result a guest program sees
 * for a name the host resolver answers, a name that does not exist, and a
 * machine with no resolver at all.
 */
#include <arpa/inet.h>
#include <netdb.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>

int main(int argc, char **argv) {
    for (int i = 1; i < argc; i++) {
        struct addrinfo hints, *res = NULL;
        memset(&hints, 0, sizeof(hints));
        hints.ai_family = AF_INET;
        hints.ai_socktype = SOCK_STREAM;
        int err = getaddrinfo(argv[i], NULL, &hints, &res);
        if (err != 0) {
            printf("%s error %d %s\n", argv[i], err, gai_strerror(err));
            continue;
        }
        char ip[INET_ADDRSTRLEN];
        const struct sockaddr_in *sin = (const struct sockaddr_in *)res->ai_addr;
        inet_ntop(AF_INET, &sin->sin_addr, ip, sizeof(ip));
        printf("%s ok %s\n", argv[i], ip);
        freeaddrinfo(res);
    }
    return 0;
}
