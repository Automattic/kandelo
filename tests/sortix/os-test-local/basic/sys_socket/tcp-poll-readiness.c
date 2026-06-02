/* Test TCP listener and stream poll readiness. */

#include <sys/socket.h>

#include <poll.h>
#include <string.h>
#include <unistd.h>

#include "tcp.h"

static void test_listener_poll(void)
{
	struct sockaddr_in addr;
	int listen_fd = tcp_listen_loopback(&addr);
	struct pollfd pfd =
	{
		.fd = listen_fd,
		.events = POLLIN,
	};
	int num_events = poll(&pfd, 1, 0);
	if ( num_events < 0 )
		err(1, "poll");
	if ( num_events != 0 )
		errx(1, "empty listener reported ready");

	int client_fd = socket(AF_INET, SOCK_STREAM, 0);
	if ( client_fd < 0 )
		err(1, "client socket");
	if ( connect(client_fd, (const struct sockaddr*) &addr, sizeof(addr)) < 0 )
		err(1, "connect");
	pfd.revents = 0;
	num_events = poll(&pfd, 1, 0);
	if ( num_events < 0 )
		err(1, "poll");
	if ( num_events != 1 )
		errx(1, "listener did not report pending connection");
	if ( !(pfd.revents & POLLIN) )
		errx(1, "listener did not report POLLIN");

	int server_fd = accept(listen_fd, NULL, NULL);
	if ( server_fd < 0 )
		err(1, "accept");
	if ( close(server_fd) < 0 || close(client_fd) < 0 || close(listen_fd) < 0 )
		err(1, "close");
}

static void test_stream_poll(void)
{
	int client_fd;
	int server_fd;
	tcp_connected_pair(&client_fd, &server_fd);
	struct pollfd pfd =
	{
		.fd = server_fd,
		.events = POLLIN | POLLOUT,
	};
	int num_events = poll(&pfd, 1, 0);
	if ( num_events < 0 )
		err(1, "poll");
	if ( pfd.revents & POLLIN )
		errx(1, "stream reported POLLIN before data");
	if ( !(pfd.revents & POLLOUT) )
		errx(1, "stream did not report POLLOUT");

	const char request[] = "ready";
	char request_buffer[sizeof(request)];
	tcp_send_all(client_fd, request, sizeof(request));
	pfd.revents = 0;
	pfd.events = POLLIN;
	num_events = poll(&pfd, 1, 1000);
	if ( num_events < 0 )
		err(1, "poll");
	if ( num_events != 1 )
		errx(1, "stream did not report readable data");
	if ( !(pfd.revents & POLLIN) )
		errx(1, "stream did not report POLLIN");
	tcp_recv_exact(server_fd, request_buffer, sizeof(request_buffer));
	if ( memcmp(request, request_buffer, sizeof(request)) != 0 )
		errx(1, "server received wrong payload");

	if ( close(server_fd) < 0 || close(client_fd) < 0 )
		err(1, "close");
}

int main(void)
{
	test_listener_poll();
	test_stream_poll();
	return 0;
}
