#ifndef TESTS_SORTIX_OS_TEST_BASIC_SYS_SOCKET_TCP_H
#define TESTS_SORTIX_OS_TEST_BASIC_SYS_SOCKET_TCP_H

#include <sys/socket.h>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <stdint.h>
#include <unistd.h>

#include "../basic.h"

static struct sockaddr_in tcp_loopback_addr(uint16_t port)
{
	struct sockaddr_in addr =
	{
		.sin_family = AF_INET,
		.sin_addr = { .s_addr = htonl(0x7F000001 /* 127.0.0.1 */) },
		.sin_port = htons(port),
	};
	return addr;
}

static int tcp_listen_loopback(struct sockaddr_in* addr)
{
	int listen_fd = socket(AF_INET, SOCK_STREAM, 0);
	if ( listen_fd < 0 )
		err(1, "socket");
	*addr = tcp_loopback_addr(0);
	if ( bind(listen_fd, (const struct sockaddr*) addr, sizeof(*addr)) < 0 )
		err(1, "bind");
	if ( listen(listen_fd, 1) < 0 )
		err(1, "listen");
	socklen_t addr_len = sizeof(*addr);
	if ( getsockname(listen_fd, (struct sockaddr*) addr, &addr_len) < 0 )
		err(1, "getsockname");
	if ( addr_len != sizeof(*addr) )
		errx(1, "getsockname returned odd length");
	return listen_fd;
}

static void tcp_send_all(int fd, const void* buffer, size_t size)
{
	const char* bytes = buffer;
	while ( size )
	{
		ssize_t amount = send(fd, bytes, size, 0);
		if ( amount < 0 )
			err(1, "send");
		if ( amount == 0 )
			errx(1, "send returned zero");
		bytes += amount;
		size -= amount;
	}
}

static void tcp_recv_exact(int fd, void* buffer, size_t size)
{
	char* bytes = buffer;
	while ( size )
	{
		ssize_t amount = recv(fd, bytes, size, 0);
		if ( amount < 0 )
			err(1, "recv");
		if ( amount == 0 )
			errx(1, "recv got EOF before expected data");
		bytes += amount;
		size -= amount;
	}
}

static void tcp_connected_pair(int* client_fd, int* server_fd)
{
	struct sockaddr_in addr;
	int listen_fd = tcp_listen_loopback(&addr);
	*client_fd = socket(AF_INET, SOCK_STREAM, 0);
	if ( *client_fd < 0 )
		err(1, "client socket");
	if ( connect(*client_fd, (const struct sockaddr*) &addr, sizeof(addr)) < 0 )
		err(1, "connect");
	*server_fd = accept(listen_fd, NULL, NULL);
	if ( *server_fd < 0 )
		err(1, "accept");
	if ( close(listen_fd) < 0 )
		err(1, "close");
}

#endif
