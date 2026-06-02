/* Test TCP bind/listen address and port conflict rules. */

#include <sys/socket.h>

#include <errno.h>
#include <unistd.h>

#include "tcp.h"

static int tcp_socket(void)
{
	int fd = socket(AF_INET, SOCK_STREAM, 0);
	if ( fd < 0 )
		err(1, "socket");
	return fd;
}

static void expect_bind_inuse(int fd, struct sockaddr_in addr, const char* what)
{
	if ( bind(fd, (const struct sockaddr*) &addr, sizeof(addr)) == 0 )
		errx(1, "%s: bind unexpectedly succeeded", what);
	if ( errno != EADDRINUSE )
		err(1, "%s: bind", what);
}

int main(void)
{
	struct sockaddr_in loopback = tcp_loopback_addr(0);
	int first = tcp_socket();
	if ( bind(first, (const struct sockaddr*) &loopback, sizeof(loopback)) < 0 )
		err(1, "bind first");
	socklen_t addr_len = sizeof(loopback);
	if ( getsockname(first, (struct sockaddr*) &loopback, &addr_len) < 0 )
		err(1, "getsockname");
	if ( listen(first, 1) < 0 )
		err(1, "listen first");

	int same_loopback = tcp_socket();
	expect_bind_inuse(same_loopback, loopback, "same loopback");

	struct sockaddr_in any = loopback;
	any.sin_addr.s_addr = htonl(INADDR_ANY);
	int any_conflict = tcp_socket();
	expect_bind_inuse(any_conflict, any, "any conflicts with loopback");

	if ( close(first) < 0 )
		err(1, "close first");

	int any_first = tcp_socket();
	if ( bind(any_first, (const struct sockaddr*) &any, sizeof(any)) < 0 )
		err(1, "bind any");
	if ( listen(any_first, 1) < 0 )
		err(1, "listen any");

	int loopback_conflict = tcp_socket();
	expect_bind_inuse(loopback_conflict, loopback, "loopback conflicts with any");

	if ( close(loopback_conflict) < 0 ||
	     close(any_conflict) < 0 ||
	     close(same_loopback) < 0 ||
	     close(any_first) < 0 )
		err(1, "close");
	return 0;
}
