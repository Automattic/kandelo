/*
 * Fill Kandelo's documented 128-datagram UDP receive queue, then verify that
 * later arrivals are dropped without evicting or reordering accepted data.
 */

#include "udp.h"

#include <stdint.h>

int main(void)
{
	int recv_fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
	if ( recv_fd < 0 )
		err(1, "receiver socket");

	struct sockaddr_in recv_addr;
	memset(&recv_addr, 0, sizeof(recv_addr));
	recv_addr.sin_family = AF_INET;
	recv_addr.sin_addr.s_addr = htobe32(INADDR_LOOPBACK);
	if ( bind(recv_fd, (const struct sockaddr*) &recv_addr,
	          sizeof(recv_addr)) < 0 )
		err(1, "receiver bind");

	socklen_t recv_addr_len = sizeof(recv_addr);
	if ( getsockname(recv_fd, (struct sockaddr*) &recv_addr,
	                 &recv_addr_len) < 0 )
		err(1, "receiver getsockname");

	int send_fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
	if ( send_fd < 0 )
		err(1, "sender socket");

	for ( uint32_t sequence = 0; sequence < 130; sequence++ )
	{
		uint32_t payload = htobe32(sequence);
		ssize_t amount = sendto(send_fd, &payload, sizeof(payload), 0,
		                        (const struct sockaddr*) &recv_addr,
		                        recv_addr_len);
		if ( amount < 0 )
			err(1, "sendto");
		if ( amount != (ssize_t) sizeof(payload) )
			errx(1, "sendto returned %zi", amount);
	}

	for ( uint32_t expected = 0; expected < 128; expected++ )
	{
		uint32_t payload = 0;
		ssize_t amount = recv(recv_fd, &payload, sizeof(payload),
		                      MSG_DONTWAIT);
		if ( amount < 0 )
			err(1, "recv sequence %u", expected);
		if ( amount != (ssize_t) sizeof(payload) )
			errx(1, "recv returned %zi", amount);
		uint32_t actual = be32toh(payload);
		if ( actual != expected )
			errx(1, "sequence %u arrived as %u", expected, actual);
	}

	uint32_t payload = 0;
	errno = 0;
	if ( recv(recv_fd, &payload, sizeof(payload), MSG_DONTWAIT) != -1 )
		errx(1, "overflow datagram unexpectedly remained queued");
	if ( errno != EAGAIN && errno != EWOULDBLOCK )
		err(1, "final recv");

	if ( close(send_fd) < 0 || close(recv_fd) < 0 )
		err(1, "close");
	puts("ok");
	return 0;
}
