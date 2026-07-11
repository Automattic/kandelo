/*
 * AF_UNIX datagrams are reliable: a full receive queue must make a
 * nonblocking sender report EAGAIN without discarding or reordering messages.
 */

#include "udp.h"

#include <stddef.h>
#include <stdint.h>
#include <sys/un.h>

int main(void)
{
	const char* path = "/tmp/kandelo-unix-dgram-overflow.sock";
	if ( unlink(path) < 0 && errno != ENOENT )
		err(1, "unlink before bind");

	int recv_fd = socket(AF_UNIX, SOCK_DGRAM, 0);
	if ( recv_fd < 0 )
		err(1, "receiver socket");

	struct sockaddr_un addr;
	memset(&addr, 0, sizeof(addr));
	addr.sun_family = AF_UNIX;
	strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);
	socklen_t addr_len =
		(socklen_t) (offsetof(struct sockaddr_un, sun_path) +
		             strlen(addr.sun_path) + 1);
	if ( bind(recv_fd, (const struct sockaddr*) &addr, addr_len) < 0 )
		err(1, "receiver bind");

	int send_fd = socket(AF_UNIX, SOCK_DGRAM, 0);
	if ( send_fd < 0 )
		err(1, "sender socket");
	if ( connect(send_fd, (const struct sockaddr*) &addr, addr_len) < 0 )
		err(1, "sender connect");
	int flags = fcntl(send_fd, F_GETFL);
	if ( flags < 0 || fcntl(send_fd, F_SETFL, flags | O_NONBLOCK) < 0 )
		err(1, "sender nonblock");

	for ( uint32_t sequence = 0; sequence < 128; sequence++ )
	{
		uint32_t payload = htobe32(sequence);
		ssize_t amount = send(send_fd, &payload, sizeof(payload), 0);
		if ( amount < 0 )
			err(1, "send sequence %u", sequence);
		if ( amount != (ssize_t) sizeof(payload) )
			errx(1, "send returned %zi", amount);
	}

	struct pollfd pfd = { .fd = send_fd, .events = POLLOUT, .revents = 0 };
	if ( poll(&pfd, 1, 0) != 0 || pfd.revents != 0 )
		errx(1, "full peer unexpectedly writable: revents=%#x", pfd.revents);

	uint32_t payload = htobe32(128);
	errno = 0;
	if ( send(send_fd, &payload, sizeof(payload), 0) != -1 )
		errx(1, "send to full peer unexpectedly succeeded");
	if ( errno != EAGAIN && errno != EWOULDBLOCK )
		err(1, "send to full peer");

	uint32_t first = 0;
	if ( recv(recv_fd, &first, sizeof(first), MSG_DONTWAIT) !=
	     (ssize_t) sizeof(first) )
		err(1, "recv first");
	if ( be32toh(first) != 0 )
		errx(1, "first sequence was %u", be32toh(first));

	pfd.revents = 0;
	if ( poll(&pfd, 1, 0) != 1 || !(pfd.revents & POLLOUT) )
		errx(1, "drained peer not writable: revents=%#x", pfd.revents);
	if ( send(send_fd, &payload, sizeof(payload), 0) !=
	     (ssize_t) sizeof(payload) )
		err(1, "retry send");

	for ( uint32_t expected = 1; expected <= 128; expected++ )
	{
		uint32_t actual = 0;
		if ( recv(recv_fd, &actual, sizeof(actual), MSG_DONTWAIT) !=
		     (ssize_t) sizeof(actual) )
			err(1, "recv sequence %u", expected);
		if ( be32toh(actual) != expected )
			errx(1, "sequence %u arrived as %u", expected, be32toh(actual));
	}

	if ( close(send_fd) < 0 || close(recv_fd) < 0 )
		err(1, "close");
	if ( unlink(path) < 0 )
		err(1, "unlink after close");
	puts("ok");
	return 0;
}
