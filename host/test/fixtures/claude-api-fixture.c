/* Local Messages API fixture. No external service or real credential is used. */
#define _POSIX_C_SOURCE 200809L
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <signal.h>

static void send_all(int fd, const char *bytes) {
    size_t left = strlen(bytes);
    while (left) {
        ssize_t n = write(fd, bytes, left);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return; /* Clients may cancel background requests. */
        bytes += n; left -= (size_t)n;
    }
}

int main(void) {
    signal(SIGPIPE, SIG_IGN);
    int listener = socket(AF_INET, SOCK_STREAM, 0);
    if (listener < 0) { perror("mock socket"); return 2; }
    struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = htons(34321),
        .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    if (bind(listener, (struct sockaddr *)&address, sizeof(address)) || listen(listener, 8)) {
        perror("mock listen"); return 2;
    }
    puts("claude-api-fixture-ready"); fflush(stdout);
    char *request = malloc(2 * 1024 * 1024);
    if (!request) return 2;
    for (;;) {
        int client = accept(listener, NULL, NULL);
        if (client < 0) { if (errno == EINTR) continue; perror("mock accept"); return 2; }
        size_t size = 0, needed = 0;
        int has_headers = 0;
        while (size < 2 * 1024 * 1024 - 1) {
            ssize_t n = read(client, request + size, 2 * 1024 * 1024 - 1 - size);
            if (n < 0 && errno == EINTR) continue;
            if (n <= 0) break;
            size += (size_t)n; request[size] = 0;
            if (!has_headers) {
                char *end = strstr(request, "\r\n\r\n");
                if (!end) continue;
                needed = (size_t)(end - request) + 4;
                for (char *p = request; p < end; p++) {
                    if ((p == request || p[-1] == '\n') && !strncasecmp(p, "Content-Length:", 15)) {
                        needed += strtoul(p + 15, NULL, 10); break;
                    }
                }
                has_headers = 1;
            }
            if (size >= needed) break;
        }
        if (!has_headers || size < needed) { close(client); continue; }
        if (!strncmp(request, "POST /v1/messages/count_tokens", sizeof("POST /v1/messages/count_tokens") - 1)) {
            send_all(client, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 20\r\nConnection: close\r\n\r\n{\"input_tokens\":100}");
        } else if (!strncmp(request, "POST /v1/messages", sizeof("POST /v1/messages") - 1)) {
            puts("claude-api-fixture-messages"); fflush(stdout);
            const char *body = "{\"id\":\"msg_kandelo_test\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-6\",\"content\":[{\"type\":\"text\",\"text\":\"kandelo-mock-response\"}],\"stop_reason\":\"end_turn\",\"stop_sequence\":null,\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}";
            if (strstr(request, "\"stream\":true") || strstr(request, "\"stream\": true")) {
                puts("claude-api-fixture-stream"); fflush(stdout);
                send_all(client, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n");
                send_all(client, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_kandelo_test\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-6\",\"content\":[],\"stop_reason\":null,\"stop_sequence\":null,\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n");
                send_all(client, "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n");
                send_all(client, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"kandelo-mock-response\"}}\n\n");
                send_all(client, "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n");
                send_all(client, "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":1}}\n\n");
                send_all(client, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
            } else {
                puts("claude-api-fixture-nonstream"); fflush(stdout);
                char header[160];
                snprintf(header, sizeof(header), "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n", strlen(body));
                send_all(client, header); send_all(client, body);
            }
        } else {
            send_all(client, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        }
        close(client);
    }
}
