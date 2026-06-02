/* Test that TCP shutdown(SHUT_WR) sends EOF without closing reads. */

#include <sys/socket.h>

#include <string.h>
#include <unistd.h>

#include "tcp.h"

int main(void)
{
	int client_fd;
	int server_fd;
	tcp_connected_pair(&client_fd, &server_fd);

	const char request[] = "half-close";
	char request_buffer[sizeof(request)];
	tcp_send_all(client_fd, request, sizeof(request));
	if ( shutdown(client_fd, SHUT_WR) < 0 )
		err(1, "shutdown");
	tcp_recv_exact(server_fd, request_buffer, sizeof(request_buffer));
	if ( memcmp(request, request_buffer, sizeof(request)) != 0 )
		errx(1, "server received wrong payload");
	char byte = 0;
	ssize_t amount = recv(server_fd, &byte, 1, 0);
	if ( amount < 0 )
		err(1, "recv");
	if ( amount != 0 )
		errx(1, "server did not receive EOF");

	const char response[] = "still-readable";
	char response_buffer[sizeof(response)];
	tcp_send_all(server_fd, response, sizeof(response));
	tcp_recv_exact(client_fd, response_buffer, sizeof(response_buffer));
	if ( memcmp(response, response_buffer, sizeof(response)) != 0 )
		errx(1, "client received wrong payload");

	if ( close(server_fd) < 0 || close(client_fd) < 0 )
		err(1, "close");
	return 0;
}
