/*
 * Exercise datagram flag semantics through the guest syscall ABI:
 * IPv4 limited-broadcast permission, Linux MSG_TRUNC length reporting for
 * IPv4/IPv6/Unix datagrams, and Kandelo's documented fixed buffer readback.
 */

#include "udp.h"

#include <stddef.h>
#include <stdint.h>
#include <sys/un.h>

static void check_fixed_buffer_readback(int fd)
{
	int recv_capacity = 0;
	int send_capacity = 0;
	socklen_t value_len = sizeof(int);
	if ( getsockopt(fd,
	                SOL_SOCKET,
	                SO_RCVBUF,
	                &recv_capacity,
	                &value_len) < 0 )
		err(1, "initial SO_RCVBUF");
	if ( value_len != sizeof(int) )
		errx(1, "initial SO_RCVBUF returned length %u", value_len);
	value_len = sizeof(int);
	if ( getsockopt(fd,
	                SOL_SOCKET,
	                SO_SNDBUF,
	                &send_capacity,
	                &value_len) < 0 )
		err(1, "initial SO_SNDBUF");
	if ( value_len != sizeof(int) )
		errx(1, "initial SO_SNDBUF returned length %u", value_len);

	int requested_recv = 1;
	int requested_send = 1;
	if ( setsockopt(fd,
	                SOL_SOCKET,
	                SO_RCVBUF,
	                &requested_recv,
	                sizeof(requested_recv)) < 0 )
		err(1, "advisory SO_RCVBUF request");
	if ( setsockopt(fd,
	                SOL_SOCKET,
	                SO_SNDBUF,
	                &requested_send,
	                sizeof(requested_send)) < 0 )
		err(1, "advisory SO_SNDBUF request");

	int readback = 0;
	value_len = sizeof(int);
	if ( getsockopt(fd,
	                SOL_SOCKET,
	                SO_RCVBUF,
	                &readback,
	                &value_len) < 0 )
		err(1, "SO_RCVBUF readback");
	if ( value_len != sizeof(int) )
		errx(1, "SO_RCVBUF readback returned length %u", value_len);
	if ( readback != recv_capacity )
		errx(1,
		     "SO_RCVBUF fabricated requested capacity: initial=%d readback=%d",
		     recv_capacity,
		     readback);
	value_len = sizeof(int);
	if ( getsockopt(fd,
	                SOL_SOCKET,
	                SO_SNDBUF,
	                &readback,
	                &value_len) < 0 )
		err(1, "SO_SNDBUF readback");
	if ( value_len != sizeof(int) )
		errx(1, "SO_SNDBUF readback returned length %u", value_len);
	if ( readback != send_capacity )
		errx(1,
		     "SO_SNDBUF fabricated requested capacity: initial=%d readback=%d",
		     send_capacity,
		     readback);
}

static void check_limited_broadcast_permission(void)
{
	int fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
	if ( fd < 0 )
		err(1, "broadcast socket");
	struct sockaddr_in broadcast;
	memset(&broadcast, 0, sizeof(broadcast));
	broadcast.sin_family = AF_INET;
	broadcast.sin_port = htobe16(9);
	broadcast.sin_addr.s_addr = htobe32(INADDR_BROADCAST);

	errno = 0;
	if ( sendto(fd,
	            "x",
	            1,
	            0,
	            (const struct sockaddr*) &broadcast,
	            sizeof(broadcast)) != -1 )
		errx(1, "limited broadcast unexpectedly sent without SO_BROADCAST");
	if ( errno != EACCES )
		err(1, "limited broadcast without SO_BROADCAST");

	int enabled = 1;
	if ( setsockopt(fd,
	                SOL_SOCKET,
	                SO_BROADCAST,
	                &enabled,
	                sizeof(enabled)) < 0 )
		err(1, "enable SO_BROADCAST");
	errno = 0;
	ssize_t sent = sendto(fd,
	                      "x",
	                      1,
	                      0,
	                      (const struct sockaddr*) &broadcast,
	                      sizeof(broadcast));
	if ( sent < 0 && errno != ENETUNREACH && errno != EHOSTUNREACH )
		err(1, "broadcast routing after SO_BROADCAST permission");
	if ( sent >= 0 && sent != 1 )
		errx(1, "broadcast send returned unexpected length %zd", sent);

	if ( close(fd) < 0 )
		err(1, "close broadcast socket");
}

static void check_ipv4_msg_trunc(void)
{
	int recv_fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
	int send_fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
	if ( recv_fd < 0 || send_fd < 0 )
		err(1, "IPv4 sockets");
	check_fixed_buffer_readback(recv_fd);

	struct sockaddr_in recv_addr;
	memset(&recv_addr, 0, sizeof(recv_addr));
	recv_addr.sin_family = AF_INET;
	recv_addr.sin_addr.s_addr = htobe32(INADDR_LOOPBACK);
	if ( bind(recv_fd,
	          (const struct sockaddr*) &recv_addr,
	          sizeof(recv_addr)) < 0 )
		err(1, "IPv4 receiver bind");
	socklen_t recv_addr_len = sizeof(recv_addr);
	if ( getsockname(recv_fd,
	                 (struct sockaddr*) &recv_addr,
	                 &recv_addr_len) < 0 )
		err(1, "IPv4 receiver getsockname");

	const char first[] = "0123456789";
	if ( sendto(send_fd,
	            first,
	            sizeof(first) - 1,
	            0,
	            (const struct sockaddr*) &recv_addr,
	            recv_addr_len) != (ssize_t) (sizeof(first) - 1) )
		err(1, "IPv4 first send");
	unsigned char guarded[6];
	memset(guarded, 0xa5, sizeof(guarded));
	ssize_t received = recvfrom(recv_fd,
	                            guarded,
	                            4,
	                            MSG_PEEK | MSG_TRUNC,
	                            NULL,
	                            NULL);
	if ( received < 0 )
		err(1, "IPv4 MSG_PEEK|MSG_TRUNC");
	if ( received != (ssize_t) (sizeof(first) - 1) )
		errx(1, "IPv4 MSG_PEEK|MSG_TRUNC returned %zd", received);
	if ( memcmp(guarded, "0123", 4) != 0 ||
	     guarded[4] != 0xa5 || guarded[5] != 0xa5 )
		errx(1, "IPv4 MSG_TRUNC overwrote its bounded destination");
	struct sockaddr_in from;
	memset(&from, 0, sizeof(from));
	socklen_t from_len = sizeof(from);
	received = recvfrom(recv_fd,
	                    guarded,
	                    4,
	                    MSG_TRUNC,
	                    (struct sockaddr*) &from,
	                    &from_len);
	if ( received < 0 )
		err(1, "IPv4 MSG_TRUNC consume");
	if ( received != (ssize_t) (sizeof(first) - 1) )
		errx(1, "IPv4 MSG_TRUNC consume returned %zd", received);
	if ( memcmp(guarded, "0123", 4) != 0 ||
	     guarded[4] != 0xa5 || guarded[5] != 0xa5 )
		errx(1, "IPv4 consuming MSG_TRUNC overwrote its bounded destination");
	if ( from_len != sizeof(from) || from.sin_family != AF_INET )
		errx(1,
		     "IPv4 MSG_TRUNC source address malformed: family=%d length=%u",
		     from.sin_family,
		     from_len);

	const char second[] = "abcdefghij";
	if ( sendto(send_fd,
	            second,
	            sizeof(second) - 1,
	            0,
	            (const struct sockaddr*) &recv_addr,
	            recv_addr_len) != (ssize_t) (sizeof(second) - 1) )
		err(1, "IPv4 second send");
	received = recvfrom(recv_fd, guarded, 4, 0, NULL, NULL);
	if ( received < 0 )
		err(1, "IPv4 unflagged truncated receive");
	if ( received != 4 )
		errx(1, "IPv4 unflagged truncated receive returned %zd", received);
	if ( memcmp(guarded, "abcd", 4) != 0 )
		errx(1, "IPv4 unflagged receive copied wrong prefix");

	const char zero_buffer[] = "zero-buffer";
	if ( sendto(send_fd,
	            zero_buffer,
	            sizeof(zero_buffer) - 1,
	            0,
	            (const struct sockaddr*) &recv_addr,
	            recv_addr_len) != (ssize_t) (sizeof(zero_buffer) - 1) )
		err(1, "IPv4 zero-buffer send");
	memset(guarded, 0xa5, sizeof(guarded));
	received = recvfrom(recv_fd,
	                    guarded,
	                    0,
	                    MSG_PEEK | MSG_TRUNC,
	                    NULL,
	                    NULL);
	if ( received < 0 )
		err(1, "IPv4 zero-buffer peek");
	if ( received != (ssize_t) (sizeof(zero_buffer) - 1) )
		errx(1, "IPv4 zero-buffer peek returned %zd", received);
	for ( size_t i = 0; i < sizeof(guarded); i++ )
		if ( guarded[i] != 0xa5 )
			errx(1, "IPv4 zero-buffer peek wrote byte %zu", i);
	received = recvfrom(recv_fd,
	                    guarded,
	                    0,
	                    MSG_TRUNC,
	                    NULL,
	                    NULL);
	if ( received < 0 )
		err(1, "IPv4 zero-buffer consume");
	if ( received != (ssize_t) (sizeof(zero_buffer) - 1) )
		errx(1, "IPv4 zero-buffer consume returned %zd", received);
	for ( size_t i = 0; i < sizeof(guarded); i++ )
		if ( guarded[i] != 0xa5 )
			errx(1, "IPv4 zero-buffer consume wrote byte %zu", i);
	errno = 0;
	if ( recvfrom(recv_fd,
	              guarded,
	              0,
	              MSG_DONTWAIT | MSG_TRUNC,
	              NULL,
	              NULL) != -1 )
		errx(1, "IPv4 zero-buffer consume did not dequeue the datagram");
	if ( errno != EAGAIN )
		err(1, "IPv4 receive after zero-buffer consume");

	struct sockaddr_in send_addr;
	memset(&send_addr, 0, sizeof(send_addr));
	socklen_t send_addr_len = sizeof(send_addr);
	if ( getsockname(send_fd,
	                 (struct sockaddr*) &send_addr,
	                 &send_addr_len) < 0 )
		err(1, "IPv4 sender getsockname");
	send_addr.sin_addr.s_addr = htobe32(INADDR_LOOPBACK);
	if ( connect(recv_fd,
	             (const struct sockaddr*) &send_addr,
	             send_addr_len) < 0 )
		err(1, "IPv4 receiver connect");
	const char connected[] = "connected-recv";
	if ( sendto(send_fd,
	            connected,
	            sizeof(connected) - 1,
	            0,
	            (const struct sockaddr*) &recv_addr,
	            recv_addr_len) != (ssize_t) (sizeof(connected) - 1) )
		err(1, "IPv4 connected-recv send");
	received = recv(recv_fd, guarded, 4, MSG_TRUNC);
	if ( received < 0 )
		err(1, "IPv4 connected recv MSG_TRUNC");
	if ( received != (ssize_t) (sizeof(connected) - 1) )
		errx(1, "IPv4 connected recv MSG_TRUNC returned %zd", received);

	const char recvmsg_payload[] = "recvmsg-trunc";
	if ( sendto(send_fd,
	            recvmsg_payload,
	            sizeof(recvmsg_payload) - 1,
	            0,
	            (const struct sockaddr*) &recv_addr,
	            recv_addr_len) != (ssize_t) (sizeof(recvmsg_payload) - 1) )
		err(1, "IPv4 recvmsg send");
	memset(guarded, 0xa5, sizeof(guarded));
	struct iovec iov = { .iov_base = guarded, .iov_len = 4 };
	struct msghdr message;
	memset(&message, 0, sizeof(message));
	message.msg_iov = &iov;
	message.msg_iovlen = 1;
	received = recvmsg(recv_fd, &message, MSG_TRUNC);
	if ( received < 0 )
		err(1, "IPv4 recvmsg MSG_TRUNC");
	if ( received != (ssize_t) (sizeof(recvmsg_payload) - 1) )
		errx(1, "IPv4 recvmsg MSG_TRUNC returned %zd", received);
	if ( memcmp(guarded, "recv", 4) != 0 ||
	     guarded[4] != 0xa5 || guarded[5] != 0xa5 )
		errx(1, "IPv4 recvmsg MSG_TRUNC overwrote its bounded destination");

	const char recvmsg_zero[] = "recvmsg-zero";
	if ( sendto(send_fd,
	            recvmsg_zero,
	            sizeof(recvmsg_zero) - 1,
	            0,
	            (const struct sockaddr*) &recv_addr,
	            recv_addr_len) != (ssize_t) (sizeof(recvmsg_zero) - 1) )
		err(1, "IPv4 zero-buffer recvmsg send");
	iov.iov_len = 0;
	received = recvmsg(recv_fd, &message, MSG_TRUNC);
	if ( received < 0 )
		err(1, "IPv4 zero-buffer recvmsg MSG_TRUNC");
	if ( received != (ssize_t) (sizeof(recvmsg_zero) - 1) )
		errx(1, "IPv4 zero-buffer recvmsg MSG_TRUNC returned %zd", received);
	for ( size_t i = 0; i < sizeof(guarded); i++ )
		if ( guarded[i] != (i < 4 ? (unsigned char) "recv"[i] : 0xa5) )
			errx(1, "IPv4 zero-buffer recvmsg wrote byte %zu", i);

	if ( close(send_fd) < 0 || close(recv_fd) < 0 )
		err(1, "close IPv4 sockets");
}

static void check_ipv6_msg_trunc(void)
{
	int recv_fd = socket(AF_INET6, SOCK_DGRAM, IPPROTO_UDP);
	int send_fd = socket(AF_INET6, SOCK_DGRAM, IPPROTO_UDP);
	if ( recv_fd < 0 || send_fd < 0 )
		err(1, "IPv6 sockets");

	struct sockaddr_in6 recv_addr;
	memset(&recv_addr, 0, sizeof(recv_addr));
	recv_addr.sin6_family = AF_INET6;
	recv_addr.sin6_addr.s6_addr[15] = 1;
	if ( bind(recv_fd,
	          (const struct sockaddr*) &recv_addr,
	          sizeof(recv_addr)) < 0 )
		err(1, "IPv6 receiver bind");
	socklen_t recv_addr_len = sizeof(recv_addr);
	if ( getsockname(recv_fd,
	                 (struct sockaddr*) &recv_addr,
	                 &recv_addr_len) < 0 )
		err(1, "IPv6 receiver getsockname");

	const char payload[] = "ipv6-truncated";
	if ( sendto(send_fd,
	            payload,
	            sizeof(payload) - 1,
	            0,
	            (const struct sockaddr*) &recv_addr,
	            recv_addr_len) != (ssize_t) (sizeof(payload) - 1) )
		err(1, "IPv6 send");
	char buf[4];
	ssize_t received =
		recvfrom(recv_fd, buf, sizeof(buf), MSG_TRUNC, NULL, NULL);
	if ( received < 0 )
		err(1, "IPv6 MSG_TRUNC");
	if ( received != (ssize_t) (sizeof(payload) - 1) )
		errx(1, "IPv6 MSG_TRUNC returned %zd", received);
	if ( memcmp(buf, "ipv6", sizeof(buf)) != 0 )
		errx(1, "IPv6 MSG_TRUNC copied wrong prefix");

	if ( close(send_fd) < 0 || close(recv_fd) < 0 )
		err(1, "close IPv6 sockets");
}

static void check_unix_msg_trunc(void)
{
	const char* recv_path = "/tmp/kandelo-dgram-flags-recv.sock";
	const char* send_path = "/tmp/kandelo-dgram-flags-send.sock";
	if ( unlink(recv_path) < 0 && errno != ENOENT )
		err(1, "unlink Unix receiver before bind");
	if ( unlink(send_path) < 0 && errno != ENOENT )
		err(1, "unlink Unix sender before bind");

	int recv_fd = socket(AF_UNIX, SOCK_DGRAM, 0);
	int send_fd = socket(AF_UNIX, SOCK_DGRAM, 0);
	if ( recv_fd < 0 || send_fd < 0 )
		err(1, "Unix sockets");
	check_fixed_buffer_readback(recv_fd);
	struct sockaddr_un recv_addr;
	memset(&recv_addr, 0, sizeof(recv_addr));
	recv_addr.sun_family = AF_UNIX;
	strncpy(recv_addr.sun_path,
	        recv_path,
	        sizeof(recv_addr.sun_path) - 1);
	socklen_t recv_addr_len =
		(socklen_t) (offsetof(struct sockaddr_un, sun_path) +
		             strlen(recv_addr.sun_path) + 1);
	if ( bind(recv_fd,
	          (const struct sockaddr*) &recv_addr,
	          recv_addr_len) < 0 )
		err(1, "Unix receiver bind");
	struct sockaddr_un send_addr;
	memset(&send_addr, 0, sizeof(send_addr));
	send_addr.sun_family = AF_UNIX;
	strncpy(send_addr.sun_path,
	        send_path,
	        sizeof(send_addr.sun_path) - 1);
	socklen_t send_addr_len =
		(socklen_t) (offsetof(struct sockaddr_un, sun_path) +
		             strlen(send_addr.sun_path) + 1);
	if ( bind(send_fd,
	          (const struct sockaddr*) &send_addr,
	          send_addr_len) < 0 )
		err(1, "Unix sender bind");
	if ( connect(send_fd,
	             (const struct sockaddr*) &recv_addr,
	             recv_addr_len) < 0 )
		err(1, "Unix sender connect");

	const char payload[] = "reliable-unix";
	if ( send(send_fd, payload, sizeof(payload) - 1, 0) !=
	     (ssize_t) (sizeof(payload) - 1) )
		err(1, "Unix initial send");
	char buf[4];
	ssize_t received = recvfrom(recv_fd,
	                            buf,
	                            sizeof(buf),
	                            MSG_PEEK | MSG_TRUNC,
	                            NULL,
	                            NULL);
	if ( received < 0 )
		err(1, "Unix MSG_PEEK|MSG_TRUNC");
	if ( received != (ssize_t) (sizeof(payload) - 1) )
		errx(1, "Unix MSG_PEEK|MSG_TRUNC returned %zd", received);
	received = recvfrom(recv_fd,
	                    buf,
	                    sizeof(buf),
	                    MSG_TRUNC,
	                    NULL,
	                    NULL);
	if ( received < 0 )
		err(1, "Unix MSG_TRUNC consume");
	if ( received != (ssize_t) (sizeof(payload) - 1) )
		errx(1, "Unix MSG_TRUNC consume returned %zd", received);
	if ( memcmp(buf, "reli", sizeof(buf)) != 0 )
		errx(1, "Unix MSG_TRUNC copied wrong prefix");

	int flags = fcntl(send_fd, F_GETFL);
	if ( flags < 0 || fcntl(send_fd, F_SETFL, flags | O_NONBLOCK) < 0 )
		err(1, "Unix sender nonblock");
	for ( uint32_t sequence = 0; sequence < 128; sequence++ )
	{
		uint32_t value = htobe32(sequence);
		if ( send(send_fd, &value, sizeof(value), 0) !=
		     (ssize_t) sizeof(value) )
			err(1, "Unix queue fill at %u", sequence);
	}
	struct pollfd pfd = { .fd = send_fd, .events = POLLOUT, .revents = 0 };
	if ( poll(&pfd, 1, 0) != 0 || pfd.revents != 0 )
		errx(1, "full Unix queue unexpectedly writable: revents=%#x", pfd.revents);
	unsigned char first_byte = 0;
	received = recvfrom(recv_fd,
	                    &first_byte,
	                    sizeof(first_byte),
	                    MSG_PEEK | MSG_TRUNC,
	                    NULL,
	                    NULL);
	if ( received < 0 )
		err(1, "full Unix queue MSG_PEEK|MSG_TRUNC");
	if ( received != 4 )
		errx(1, "full Unix queue MSG_PEEK|MSG_TRUNC returned %zd", received);
	pfd.revents = 0;
	if ( poll(&pfd, 1, 0) != 0 || pfd.revents != 0 )
		errx(1, "MSG_PEEK released Unix queue capacity: revents=%#x", pfd.revents);
	received = recvfrom(recv_fd,
	                    &first_byte,
	                    sizeof(first_byte),
	                    MSG_TRUNC,
	                    NULL,
	                    NULL);
	if ( received < 0 )
		err(1, "full Unix queue MSG_TRUNC consume");
	if ( received != 4 )
		errx(1, "full Unix queue MSG_TRUNC consume returned %zd", received);
	pfd.revents = 0;
	if ( poll(&pfd, 1, 0) != 1 || !(pfd.revents & POLLOUT) )
		errx(1, "MSG_TRUNC consume did not release sender: revents=%#x", pfd.revents);

	if ( close(send_fd) < 0 || close(recv_fd) < 0 )
		err(1, "close Unix sockets");
	if ( unlink(send_path) < 0 || unlink(recv_path) < 0 )
		err(1, "unlink Unix sockets");
}

int main(void)
{
	check_limited_broadcast_permission();
	check_ipv4_msg_trunc();
	check_ipv6_msg_trunc();
	check_unix_msg_trunc();
	puts("ok");
	return 0;
}
