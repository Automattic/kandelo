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
    if (argc != 4 && argc != 5) {
        fprintf(stderr, "usage: %s ADDRESS PORT MESSAGE [POST_FIN_BYTES]\n", argv[0]);
        return 2;
    }

    size_t post_fin_bytes = 0;
    if (argc == 5) {
        char* end;
        unsigned long value = strtoul(argv[4], &end, 10);
        if (!argv[4][0] || *end || value > 16 * 1024 * 1024UL) {
            fprintf(stderr, "invalid post-FIN byte count: %s\n", argv[4]);
            return 2;
        }
        post_fin_bytes = (size_t) value;
    }

    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) die("socket");

    struct sockaddr_in server;
    memset(&server, 0, sizeof(server));
    server.sin_family = AF_INET;
    server.sin_port = htons((uint16_t) atoi(argv[2]));
    if (inet_pton(AF_INET, argv[1], &server.sin_addr) != 1) die("inet_pton");
    if (connect(fd, (struct sockaddr*) &server, sizeof(server)) < 0) die("connect");

    const char* msg = argv[3];
    size_t msg_len = strlen(msg);
    write_all(fd, msg, msg_len);

    char buf[320];
    size_t received = 0;
    for (;;) {
        ssize_t n = read(fd, buf + received, sizeof(buf) - 1 - received);
        if (n < 0) die("read");
        if (n == 0) break;
        received += (size_t) n;
        if (received == sizeof(buf) - 1) {
            fprintf(stderr, "reply too large\n");
            return 1;
        }
    }
    buf[received] = '\0';
    printf("%s\n", buf);

    /*
     * A peer FIN closes only its write half. Sending this acknowledgement
     * after EOF proves that the server's accepted socket can still receive
     * after SHUT_WR and that the host bridge did not collapse the half-close
     * into full connection teardown.
     */
    if (post_fin_bytes > 0) {
        char chunk[16 * 1024];
        memset(chunk, 'x', sizeof(chunk));
        while (post_fin_bytes > 0) {
            size_t amount = post_fin_bytes < sizeof(chunk) ? post_fin_bytes : sizeof(chunk);
            write_all(fd, chunk, amount);
            post_fin_bytes -= amount;
        }
    } else {
        const char ack[] = "ack";
        write_all(fd, ack, sizeof(ack) - 1);
    }

    close(fd);
    return 0;
}
