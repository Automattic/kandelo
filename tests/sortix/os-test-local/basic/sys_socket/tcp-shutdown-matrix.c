/* Test TCP SHUT_RD and SHUT_RDWR receive/send/poll behavior. */

#include <sys/socket.h>

#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <string.h>
#include <unistd.h>

#include "tcp.h"

#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif

static void expect_recv_eof(int fd, const char* what)
{
	char byte;
	ssize_t amount = recv(fd, &byte, sizeof(byte), 0);
	if ( amount < 0 )
		err(1, "%s: recv", what);
	if ( amount != 0 )
		errx(1, "%s: recv did not report EOF", what);
}

static void expect_send_pipe(int fd, const char* what)
{
	const char payload[] = "closed";
	ssize_t amount = send(fd, payload, sizeof(payload), MSG_NOSIGNAL);
	if ( amount >= 0 )
		errx(1, "%s: send unexpectedly succeeded", what);
	if ( errno != EPIPE && errno != ECONNRESET )
		err(1, "%s: send", what);
}

static void expect_poll_readable_not_writable(int fd, const char* what)
{
	struct pollfd pfd =
	{
		.fd = fd,
		.events = POLLIN | POLLOUT,
	};
	int num_events = poll(&pfd, 1, 0);
	if ( num_events < 0 )
		err(1, "%s: poll", what);
	if ( num_events != 1 )
		errx(1, "%s: poll did not report shutdown state", what);
	if ( !(pfd.revents & POLLIN) )
		errx(1, "%s: poll did not report POLLIN", what);
	if ( pfd.revents & POLLOUT )
		errx(1, "%s: poll reported POLLOUT after write shutdown", what);
}

static void test_shutdown_rd(void)
{
	int client_fd;
	int server_fd;
	tcp_connected_pair(&client_fd, &server_fd);

	if ( shutdown(client_fd, SHUT_RD) < 0 )
		err(1, "shutdown SHUT_RD");
	expect_recv_eof(client_fd, "SHUT_RD");

	const char payload[] = "still-writes";
	char buffer[sizeof(payload)];
	tcp_send_all(client_fd, payload, sizeof(payload));
	tcp_recv_exact(server_fd, buffer, sizeof(buffer));
	if ( memcmp(payload, buffer, sizeof(payload)) != 0 )
		errx(1, "SHUT_RD: server received wrong payload");

	if ( close(server_fd) < 0 || close(client_fd) < 0 )
		err(1, "close");
}

static void test_shutdown_rdwr(void)
{
	int client_fd;
	int server_fd;
	tcp_connected_pair(&client_fd, &server_fd);

	if ( shutdown(client_fd, SHUT_RDWR) < 0 )
		err(1, "shutdown SHUT_RDWR");
	expect_poll_readable_not_writable(client_fd, "SHUT_RDWR");
	expect_recv_eof(client_fd, "SHUT_RDWR");
	expect_send_pipe(client_fd, "SHUT_RDWR");

	if ( close(server_fd) < 0 || close(client_fd) < 0 )
		err(1, "close");
}

int main(void)
{
	if ( signal(SIGPIPE, SIG_IGN) == SIG_ERR )
		err(1, "signal");
	test_shutdown_rd();
	test_shutdown_rdwr();
	return 0;
}
