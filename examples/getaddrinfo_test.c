#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <netdb.h>
#include <arpa/inet.h>

int main(void) {
    struct addrinfo hints, *res;
    char ipstr[INET_ADDRSTRLEN];

    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;

    /* Test 1: numeric IP (should not trigger syscall) */
    int err = getaddrinfo("127.0.0.1", NULL, &hints, &res);
    if (err != 0) {
        printf("FAIL: numeric IP getaddrinfo: %s\n", gai_strerror(err));
        return 1;
    }
    struct sockaddr_in *addr = (struct sockaddr_in *)res->ai_addr;
    inet_ntop(AF_INET, &addr->sin_addr, ipstr, sizeof(ipstr));
    printf("OK: numeric IP resolved to %s\n", ipstr);
    freeaddrinfo(res);

    /* Test 2: NULL name (should return loopback) */
    err = getaddrinfo(NULL, "80", &hints, &res);
    if (err != 0) {
        printf("FAIL: NULL name getaddrinfo: %s\n", gai_strerror(err));
        return 1;
    }
    addr = (struct sockaddr_in *)res->ai_addr;
    inet_ntop(AF_INET, &addr->sin_addr, ipstr, sizeof(ipstr));
    printf("OK: NULL name resolved to %s\n", ipstr);
    freeaddrinfo(res);

    /* Test 3: hostname (triggers syscall #140) */
    err = getaddrinfo("example.com", NULL, &hints, &res);
    if (err != 0) {
        printf("FAIL: hostname getaddrinfo: %s\n", gai_strerror(err));
        return 1;
    }
    addr = (struct sockaddr_in *)res->ai_addr;
    inet_ntop(AF_INET, &addr->sin_addr, ipstr, sizeof(ipstr));
    printf("OK: example.com resolved to %s\n", ipstr);
    freeaddrinfo(res);

    printf("ALL TESTS PASSED\n");
    return 0;
}
