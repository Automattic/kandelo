#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static void die(const char* what) {
    perror(what);
    exit(1);
}

static void write_all(int fd, const void* data, size_t size) {
    const unsigned char* bytes = data;
    size_t offset = 0;
    while (offset < size) {
        ssize_t amount = write(fd, bytes + offset, size - offset);
        if (amount < 0) die("write");
        if (amount == 0) {
            fprintf(stderr, "write made no progress\n");
            exit(1);
        }
        offset += (size_t) amount;
    }
}

int main(int argc, char** argv) {
    if (argc < 2 || argc > 4) {
        fprintf(stderr, "usage: %s PORT [fork | fork-bulk BYTES | half-close | half-close-bulk BYTES | bulk BYTES]\n", argv[0]);
        return 2;
    }
    int test_fork = (argc == 3 && strcmp(argv[2], "fork") == 0) ||
                    (argc == 4 && strcmp(argv[2], "fork-bulk") == 0);
    int test_half_close = argc == 3 && strcmp(argv[2], "half-close") == 0;
    size_t bulk_bytes = 0;
    size_t post_fin_bytes = 0;
    if (argc == 4 &&
        (strcmp(argv[2], "bulk") == 0 ||
         strcmp(argv[2], "fork-bulk") == 0 ||
         strcmp(argv[2], "half-close-bulk") == 0)) {
        char* end;
        unsigned long value = strtoul(argv[3], &end, 10);
        if (!argv[3][0] || *end || value > 16 * 1024 * 1024UL) {
            fprintf(stderr, "invalid byte count: %s\n", argv[3]);
            return 2;
        }
        if (strcmp(argv[2], "bulk") == 0 || strcmp(argv[2], "fork-bulk") == 0)
            bulk_bytes = (size_t) value;
        else
            post_fin_bytes = (size_t) value;
    } else if (argc != 2 && !test_fork && !test_half_close) {
        fprintf(stderr, "unknown mode: %s\n", argv[2]);
        return 2;
    }

    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) die("socket");

    int one = 1;
    if (setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one)) < 0) die("setsockopt");

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons((uint16_t) atoi(argv[1]));
    if (bind(fd, (struct sockaddr*) &addr, sizeof(addr)) < 0) die("bind");
    if (listen(fd, 8) < 0) die("listen");

    struct sockaddr_in peer;
    socklen_t peer_len = sizeof(peer);
    int conn = accept(fd, (struct sockaddr*) &peer, &peer_len);
    if (conn < 0) die("accept");

    if (test_fork) {
        pid_t child = fork();
        if (child < 0) die("fork");
        if (child > 0) {
            close(conn);
            close(fd);
            return 0;
        }
        close(fd);
        fd = -1;
    }

    char buf[256];
    ssize_t n = read(conn, buf, sizeof(buf));
    if (n < 0) die("read");

    char out[320];
    int out_len = snprintf(out, sizeof(out), "echo:%.*s", (int) n, buf);
    if (out_len < 0 || out_len >= (int) sizeof(out)) {
        fprintf(stderr, "reply too large\n");
        return 1;
    }
    write_all(conn, out, (size_t) out_len);

    if (bulk_bytes > 0) {
        char chunk[16 * 1024];
        memset(chunk, 'x', sizeof(chunk));
        while (bulk_bytes > 0) {
            size_t amount = bulk_bytes < sizeof(chunk) ? bulk_bytes : sizeof(chunk);
            write_all(conn, chunk, amount);
            bulk_bytes -= amount;
        }
    }

    if (test_half_close || post_fin_bytes > 0) {
        if (shutdown(conn, SHUT_WR) < 0) die("shutdown");

        /* Let the host-side receive pipe fill before the guest starts reading. */
        if (post_fin_bytes > 0) usleep(200000);

        char ack[16 * 1024];
        size_t expected = post_fin_bytes > 0 ? post_fin_bytes : 3;
        size_t received = 0;
        while (received < expected) {
            size_t remaining = expected - received;
            size_t chunk_size = remaining < sizeof(ack) ? remaining : sizeof(ack);
            ssize_t amount = read(conn, ack, chunk_size);
            if (amount < 0) die("read ack");
            if (amount == 0) {
                fprintf(stderr, "EOF before acknowledgement\n");
                return 1;
            }
            for (ssize_t i = 0; i < amount; i++) {
                char expected_byte = post_fin_bytes > 0 ? 'x' : "ack"[received + (size_t) i];
                if (ack[i] != expected_byte) {
                    fprintf(stderr, "invalid acknowledgement\n");
                    return 1;
                }
            }
            received += (size_t) amount;
        }
    }

    close(conn);
    if (fd >= 0) close(fd);
    return 0;
}
