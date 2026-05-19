/*
 * https_get.c — Perform an HTTPS GET using OpenSSL over raw POSIX sockets.
 *
 * Usage: the host must provide networking (TcpNetworkBackend or TLS fetch backend).
 * Expects one argument: the hostname to connect to.
 * Connects to port 443, does TLS handshake, sends GET /, prints response.
 */
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

    /* Initialize OpenSSL */
    OPENSSL_init_ssl(0, NULL);

    /* Create SSL context */
    const SSL_METHOD *method = TLS_client_method();
    SSL_CTX *ctx = SSL_CTX_new(method);
    if (!ctx) {
        printf("FAIL: SSL_CTX_new\n");
        ERR_print_errors_fp(stdout);
        return 1;
    }

    /* Don't verify peer certificate (simplifies testing) */
    SSL_CTX_set_verify(ctx, SSL_VERIFY_NONE, NULL);

    /*
     * Force TLS 1.2 max — the MITM backend only supports TLS 1.2.
     * TLS 1.2 also works fine for real TCP connections.
     */
    SSL_CTX_set_max_proto_version(ctx, TLS1_2_VERSION);

    /*
     * Allow legacy renegotiation — needed for compatibility with
     * the WordPress Playground TLS 1.2 library's renegotiation_info
     * handling when used as a MITM backend.
     */
    SSL_CTX_set_options(ctx, SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION
                             | SSL_OP_LEGACY_SERVER_CONNECT);

    /* Resolve hostname */
    struct addrinfo hints = {0};
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    struct addrinfo *res = NULL;
    int gai = getaddrinfo(hostname, NULL, &hints, &res);
    if (gai != 0 || !res) {
        printf("FAIL: getaddrinfo: %d\n", gai);
        return 1;
    }

    /* Create socket and connect */
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        printf("FAIL: socket\n");
        return 1;
    }

    struct sockaddr_in addr;
    memcpy(&addr, res->ai_addr, sizeof(addr));
    addr.sin_port = htons(port);
    freeaddrinfo(res);

    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        printf("FAIL: connect\n");
        return 1;
    }
    printf("OK: connected to %s:%d\n", hostname, port);

    /* Create SSL connection */
    SSL *ssl = SSL_new(ctx);
    SSL_set_fd(ssl, fd);
    SSL_set_tlsext_host_name(ssl, hostname);

    if (SSL_connect(ssl) != 1) {
        printf("FAIL: SSL_connect\n");
        ERR_print_errors_fp(stdout);
        return 1;
    }
    printf("OK: TLS handshake complete (%s)\n", SSL_get_version(ssl));

    /* Send HTTP GET request */
    char request[512];
    int reqlen = snprintf(request, sizeof(request),
        "GET / HTTP/1.1\r\n"
        "Host: %s\r\n"
        "Connection: close\r\n"
        "\r\n", hostname);
    SSL_write(ssl, request, reqlen);
    printf("OK: sent HTTP request\n");

    /* Read response */
    char buf[4096];
    int total = 0;
    int n;
    while ((n = SSL_read(ssl, buf, sizeof(buf) - 1)) > 0) {
        buf[n] = '\0';
        if (total == 0) {
            /* Print first line of response (status line) */
            char *eol = strchr(buf, '\r');
            if (eol) *eol = '\0';
            printf("OK: response: %s\n", buf);
            if (eol) *eol = '\r';
        }
        total += n;
    }
    printf("OK: received %d bytes total\n", total);

    /* Cleanup */
    SSL_shutdown(ssl);
    SSL_free(ssl);
    close(fd);
    SSL_CTX_free(ctx);

    printf("PASS\n");
    return 0;
}
