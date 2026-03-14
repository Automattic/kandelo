#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netdb.h>
#include <openssl/ssl.h>
#include <openssl/err.h>

int main(int argc, char **argv)
{
    const char *hostname = argc > 1 ? argv[1] : "example.com";
    int port = 443;

    OPENSSL_init_ssl(0, NULL);

    const SSL_METHOD *method = TLS_client_method();
    SSL_CTX *ctx = SSL_CTX_new(method);
    if (!ctx) {
        printf("FAIL: SSL_CTX_new\n");
        ERR_print_errors_fp(stdout);
        return 1;
    }

    if (SSL_CTX_set_default_verify_paths(ctx) != 1) {
        SSL_CTX_load_verify_locations(ctx, "/etc/ssl/certs/ca-certificates.crt", NULL);
    }

    struct addrinfo hints = {0};
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    struct addrinfo *res = NULL;
    int gai = getaddrinfo(hostname, NULL, &hints, &res);
    if (gai != 0 || !res) {
        printf("FAIL: getaddrinfo: %d\n", gai);
        return 1;
    }

    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) { printf("FAIL: socket\n"); return 1; }

    struct sockaddr_in addr;
    memcpy(&addr, res->ai_addr, sizeof(addr));
    addr.sin_port = htons(port);
    freeaddrinfo(res);

    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        printf("FAIL: connect\n"); return 1;
    }
    printf("OK: connected to %s:%d\n", hostname, port);

    SSL *ssl = SSL_new(ctx);
    SSL_set_fd(ssl, fd);
    SSL_set_tlsext_host_name(ssl, hostname);

    if (SSL_connect(ssl) != 1) {
        printf("FAIL: SSL_connect\n");
        ERR_print_errors_fp(stdout);
        return 1;
    }
    printf("OK: TLS handshake complete (%s)\n", SSL_get_version(ssl));

    char request[512];
    int reqlen = snprintf(request, sizeof(request),
        "GET / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", hostname);
    SSL_write(ssl, request, reqlen);
    printf("OK: sent HTTP request\n");

    char buf[4096];
    int total = 0;
    int n;
    while ((n = SSL_read(ssl, buf, sizeof(buf) - 1)) > 0) {
        buf[n] = '\0';
        if (total == 0) {
            char *eol = strchr(buf, '\r');
            if (eol) *eol = '\0';
            printf("OK: response: %s\n", buf);
            if (eol) *eol = '\r';
        }
        total += n;
    }
    printf("OK: received %d bytes total\n", total);

    SSL_shutdown(ssl);
    SSL_free(ssl);
    close(fd);
    SSL_CTX_free(ctx);

    printf("PASS\n");
    return 0;
}
