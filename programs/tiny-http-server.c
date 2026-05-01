/* Minimal HTTP/1.1 server used to exercise the host's `fetchInKernel` path.
 *
 * Listens on argv[1] (default 8085), accepts a single connection, reads the
 * request headers (until "\r\n\r\n"), writes a fixed response, closes, and
 * exits. Just enough to validate that an external host caller can drive an
 * in-kernel server through the injected-connection bridge.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

static const char RESPONSE_BODY[] =
    "{\"hello\":\"from-the-kernel\"}";

int main(int argc, char **argv) {
    int port = (argc > 1) ? atoi(argv[1]) : 8085;
    if (port <= 0) port = 8085;

    int srv = socket(AF_INET, SOCK_STREAM, 0);
    if (srv < 0) { perror("socket"); return 1; }

    int yes = 1;
    setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)port);
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(srv, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("bind"); return 1;
    }
    if (listen(srv, 4) < 0) { perror("listen"); return 1; }

    fprintf(stderr, "tiny-http-server: listening on %d\n", port);
    fflush(stderr);

    int cli = accept(srv, NULL, NULL);
    if (cli < 0) { perror("accept"); return 1; }

    /* Read request headers until \r\n\r\n. We don't care about the body. */
    char buf[4096];
    size_t total = 0;
    while (total < sizeof(buf) - 1) {
        ssize_t n = read(cli, buf + total, sizeof(buf) - 1 - total);
        if (n <= 0) break;
        total += (size_t)n;
        buf[total] = '\0';
        if (strstr(buf, "\r\n\r\n")) break;
    }

    /* Echo the requested path back so the test can verify request routing. */
    char path[256] = "/";
    if (total > 0) {
        const char *sp1 = strchr(buf, ' ');
        if (sp1) {
            const char *sp2 = strchr(sp1 + 1, ' ');
            if (sp2 && (size_t)(sp2 - sp1 - 1) < sizeof(path)) {
                size_t plen = (size_t)(sp2 - sp1 - 1);
                memcpy(path, sp1 + 1, plen);
                path[plen] = '\0';
            }
        }
    }

    char body[512];
    int body_len = snprintf(body, sizeof(body),
        "{\"hello\":\"from-the-kernel\",\"path\":\"%s\"}", path);

    char header[512];
    int header_len = snprintf(header, sizeof(header),
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: application/json\r\n"
        "Content-Length: %d\r\n"
        "Connection: close\r\n"
        "X-Tiny-Server: 1\r\n"
        "\r\n",
        body_len);

    /* write() loops to defeat short writes in the unlikely case the pipe is
     * tight. The kernel pipe is 64KB so this completes in one shot. */
    const char *p = header;
    size_t left = (size_t)header_len;
    while (left > 0) {
        ssize_t n = write(cli, p, left);
        if (n <= 0) break;
        p += n; left -= (size_t)n;
    }
    p = body;
    left = (size_t)body_len;
    while (left > 0) {
        ssize_t n = write(cli, p, left);
        if (n <= 0) break;
        p += n; left -= (size_t)n;
    }

    /* Suppress unused-variable warning when the test path strips RESPONSE_BODY. */
    (void)RESPONSE_BODY;

    close(cli);
    close(srv);
    return 0;
}
