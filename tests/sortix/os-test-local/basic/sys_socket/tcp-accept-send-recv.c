/* Test TCP accept peer reporting and bidirectional send/recv. */

#include <sys/socket.h>

#include <string.h>
#include <unistd.h>

#include "tcp.h"

int main(void)
{
	struct sockaddr_in addr;
	int listen_fd = tcp_listen_loopback(&addr);
	int client_fd = socket(AF_INET, SOCK_STREAM, 0);
	if ( client_fd < 0 )
		err(1, "client socket");
	if ( connect(client_fd, (const struct sockaddr*) &addr, sizeof(addr)) < 0 )
		err(1, "connect");
	struct sockaddr_in client_name;
	socklen_t client_name_len = sizeof(client_name);
	if ( getsockname(client_fd, (struct sockaddr*) &client_name,
	                 &client_name_len) < 0 )
		err(1, "getsockname");
	if ( client_name_len != sizeof(client_name) )
		errx(1, "getsockname returned odd length");
	struct sockaddr_in peer;
	socklen_t peer_len = sizeof(peer);
	int server_fd = accept(listen_fd, (struct sockaddr*) &peer, &peer_len);
	if ( server_fd < 0 )
		err(1, "accept");
	if ( peer_len != sizeof(peer) )
		errx(1, "accept returned odd length");
	if ( memcmp(&client_name, &peer, sizeof(peer)) != 0 )
		errx(1, "accept gave wrong peer address");

	const char request[] = "client-to-server";
	char request_buffer[sizeof(request)];
	tcp_send_all(client_fd, request, sizeof(request));
	tcp_recv_exact(server_fd, request_buffer, sizeof(request_buffer));
	if ( memcmp(request, request_buffer, sizeof(request)) != 0 )
		errx(1, "server received wrong payload");

	const char response[] = "server-to-client";
	char response_buffer[sizeof(response)];
	tcp_send_all(server_fd, response, sizeof(response));
	tcp_recv_exact(client_fd, response_buffer, sizeof(response_buffer));
	if ( memcmp(response, response_buffer, sizeof(response)) != 0 )
		errx(1, "client received wrong payload");

	if ( close(server_fd) < 0 || close(client_fd) < 0 || close(listen_fd) < 0 )
		err(1, "close");
	return 0;
}
