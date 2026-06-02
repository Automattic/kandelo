/* Test failed nonblocking TCP connect readiness and SO_ERROR. */

#include <sys/socket.h>

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <string.h>
#include <unistd.h>

#include "tcp.h"

int main(void)
{
	struct sockaddr_in addr;
	int listen_fd = tcp_listen_loopback(&addr);
	if ( close(listen_fd) < 0 )
		err(1, "close");

	int client_fd = socket(AF_INET, SOCK_STREAM, 0);
	if ( client_fd < 0 )
		err(1, "client socket");
	int flags = fcntl(client_fd, F_GETFL);
	if ( flags < 0 )
		err(1, "fcntl: F_GETFL");
	if ( fcntl(client_fd, F_SETFL, flags | O_NONBLOCK) < 0 )
		err(1, "fcntl: F_SETFL");

	if ( connect(client_fd, (const struct sockaddr*) &addr, sizeof(addr)) < 0 )
	{
		if ( errno == ECONNREFUSED )
		{
			if ( close(client_fd) < 0 )
				err(1, "close");
			return 0;
		}
		if ( errno != EINPROGRESS && errno != EAGAIN )
			err(1, "connect");
	}
	else
		errx(1, "connect unexpectedly succeeded");

	struct pollfd pfd =
	{
		.fd = client_fd,
		.events = POLLOUT,
	};
	int num_events = poll(&pfd, 1, 1000);
	if ( num_events < 0 )
		err(1, "poll");
	if ( num_events != 1 )
		errx(1, "poll did not report failed connect completion");
	if ( !(pfd.revents & (POLLOUT | POLLERR | POLLHUP)) )
		errx(1, "poll did not report a connect result");

	int errnum = -1;
	socklen_t errnumlen = sizeof(errnum);
	if ( getsockopt(client_fd, SOL_SOCKET, SO_ERROR, &errnum, &errnumlen) < 0 )
		err(1, "getsockopt: SO_ERROR");
	if ( errnum != ECONNREFUSED )
		errx(1, "SO_ERROR: got %s, wanted ECONNREFUSED", strerror(errnum));

	if ( close(client_fd) < 0 )
		err(1, "close");
	return 0;
}
