#define _GNU_SOURCE

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

#define ARRAY_LENGTH(array) (sizeof(array) / sizeof((array)[0]))
#define MAX_RECEIVED_FDS 2

static const char *const self_path = "/bin/scm-rights-semantics";

struct received_message {
	ssize_t length;
	int flags;
	size_t fd_count;
	int fds[MAX_RECEIVED_FDS];
};

static int fail(const char *test, const char *detail)
{
	fprintf(stderr, "%s: %s (errno=%d: %s)\n", test, detail, errno,
	        strerror(errno));
	return -1;
}

static int close_pair(int pair[2])
{
	int result = 0;
	if (pair[0] >= 0 && close(pair[0]) < 0)
		result = -1;
	if (pair[1] >= 0 && close(pair[1]) < 0)
		result = -1;
	pair[0] = -1;
	pair[1] = -1;
	return result;
}

static ssize_t send_rights_form(int socket_fd, const void *data,
	                            size_t data_len, const int *fds,
	                            size_t fd_count, int include_iov,
	                            const struct sockaddr *destination,
	                            socklen_t destination_len)
{
	if (fd_count == 0 || fd_count > MAX_RECEIVED_FDS) {
		errno = EINVAL;
		return -1;
	}

	unsigned char control[CMSG_SPACE(MAX_RECEIVED_FDS * sizeof(int))];
	memset(control, 0, sizeof(control));
	struct iovec iov = {
		.iov_base = (void *) data,
		.iov_len = data_len,
	};
	struct msghdr message;
	memset(&message, 0, sizeof(message));
	message.msg_iov = include_iov ? &iov : NULL;
	message.msg_iovlen = include_iov ? 1 : 0;
	message.msg_name = (void *) destination;
	message.msg_namelen = destination_len;
	message.msg_control = control;
	message.msg_controllen = CMSG_SPACE(fd_count * sizeof(int));

	struct cmsghdr *cmsg = CMSG_FIRSTHDR(&message);
	if (!cmsg) {
		errno = EINVAL;
		return -1;
	}
	cmsg->cmsg_len = CMSG_LEN(fd_count * sizeof(int));
	cmsg->cmsg_level = SOL_SOCKET;
	cmsg->cmsg_type = SCM_RIGHTS;
	memcpy(CMSG_DATA(cmsg), fds, fd_count * sizeof(int));
	return sendmsg(socket_fd, &message, 0);
}

static ssize_t send_rights(int socket_fd, const void *data, size_t data_len,
	                       const int *fds, size_t fd_count)
{
	return send_rights_form(socket_fd, data, data_len, fds, fd_count, 1,
	                        NULL, 0);
}

static ssize_t send_rights_without_iov(int socket_fd, const int *fds,
	                                   size_t fd_count)
{
	return send_rights_form(socket_fd, NULL, 0, fds, fd_count, 0, NULL, 0);
}

static ssize_t send_rights_to(int socket_fd, const void *data,
	                          size_t data_len, const int *fds,
	                          size_t fd_count,
	                          const struct sockaddr *destination,
	                          socklen_t destination_len)
{
	return send_rights_form(socket_fd, data, data_len, fds, fd_count, 1,
	                        destination, destination_len);
}

static int receive_message_form(int socket_fd, void *data,
	                            size_t data_capacity, size_t fd_capacity,
	                            int recv_flags, int include_iov,
	                            struct received_message *received)
{
	if (fd_capacity > MAX_RECEIVED_FDS) {
		errno = EINVAL;
		return -1;
	}

	unsigned char control[CMSG_SPACE(MAX_RECEIVED_FDS * sizeof(int))];
	memset(control, 0, sizeof(control));
	struct iovec iov = {
		.iov_base = data,
		.iov_len = data_capacity,
	};
	struct msghdr message;
	memset(&message, 0, sizeof(message));
	message.msg_iov = include_iov ? &iov : NULL;
	message.msg_iovlen = include_iov ? 1 : 0;
	if (fd_capacity > 0) {
		message.msg_control = control;
		/*
		 * This is a logical descriptor capacity. CMSG_LEN keeps the one-FD
		 * boundary exact on both wasm32 and wasm64 even when native control
		 * alignment leaves spare bytes in CMSG_SPACE.
		 */
		message.msg_controllen = CMSG_LEN(fd_capacity * sizeof(int));
	}

	memset(received, 0, sizeof(*received));
	for (size_t i = 0; i < ARRAY_LENGTH(received->fds); ++i)
		received->fds[i] = -1;
	received->length = recvmsg(socket_fd, &message, recv_flags);
	if (received->length < 0)
		return -1;
	received->flags = message.msg_flags;

	struct cmsghdr *cmsg = CMSG_FIRSTHDR(&message);
	if (!cmsg)
		return 0;
	if (cmsg->cmsg_level != SOL_SOCKET || cmsg->cmsg_type != SCM_RIGHTS ||
	    cmsg->cmsg_len < CMSG_LEN(sizeof(int))) {
		errno = EBADMSG;
		return -1;
	}
	size_t payload_len = cmsg->cmsg_len - CMSG_LEN(0);
	if (payload_len % sizeof(int) != 0) {
		errno = EBADMSG;
		return -1;
	}
	received->fd_count = payload_len / sizeof(int);
	if (received->fd_count == 0 || received->fd_count > fd_capacity) {
		errno = EBADMSG;
		return -1;
	}
	memcpy(received->fds, CMSG_DATA(cmsg),
	       received->fd_count * sizeof(int));
	return 0;
}

static int receive_message(int socket_fd, void *data, size_t data_capacity,
	                       size_t fd_capacity, int recv_flags,
	                       struct received_message *received)
{
	return receive_message_form(socket_fd, data, data_capacity, fd_capacity,
	                            recv_flags, 1, received);
}

static int receive_message_without_iov(int socket_fd, size_t fd_capacity,
	                                   int recv_flags,
	                                   struct received_message *received)
{
	return receive_message_form(socket_fd, NULL, 0, fd_capacity, recv_flags,
	                            0, received);
}

static int expect_pipe_byte(int received_fd, int writer_fd, char expected)
{
	int flags = fcntl(received_fd, F_GETFL);
	if (flags < 0 || fcntl(received_fd, F_SETFL, flags | O_NONBLOCK) < 0)
		return -1;
	if (write(writer_fd, &expected, 1) != 1)
		return -1;
	char actual = 0;
	if (read(received_fd, &actual, 1) != 1 || actual != expected) {
		errno = EIO;
		return -1;
	}
	return 0;
}

static int expect_empty_nonblocking(int fd)
{
	char byte = 0;
	errno = 0;
	ssize_t result = recv(fd, &byte, 1, MSG_DONTWAIT);
	if (result != -1 || (errno != EAGAIN && errno != EWOULDBLOCK)) {
		errno = EIO;
		return -1;
	}
	return 0;
}

static int peek_with_short_control(int fd, char expected)
{
	char byte = 0;
	unsigned char control[CMSG_LEN(0)];
	memset(control, 0, sizeof(control));
	struct iovec iov = {
		.iov_base = &byte,
		.iov_len = 1,
	};
	struct msghdr message;
	memset(&message, 0, sizeof(message));
	message.msg_iov = &iov;
	message.msg_iovlen = 1;
	message.msg_control = control;
	message.msg_controllen = sizeof(control);
	ssize_t result = recvmsg(fd, &message, MSG_PEEK | MSG_DONTWAIT);
	if (result != 1 || byte != expected ||
	    (message.msg_flags & MSG_CTRUNC) == 0) {
		errno = EIO;
		return -1;
	}
	return 0;
}

static int poll_readable(int fd);

static int test_stream_barriers(void)
{
	static const char *const test = "stream barriers";
	int carrier[2] = { -1, -1 };
	int first_pipe[2] = { -1, -1 };
	int second_pipe[2] = { -1, -1 };
	if (socketpair(AF_UNIX, SOCK_STREAM, 0, carrier) < 0 ||
	    pipe(first_pipe) < 0 || pipe(second_pipe) < 0)
		return fail(test, "setup");

	if (write(carrier[0], "AA", 2) != 2 ||
	    send_rights(carrier[0], "B", 1, &first_pipe[0], 1) != 1 ||
	    send_rights(carrier[0], "C", 1, &second_pipe[0], 1) != 1 ||
	    write(carrier[0], "DD", 2) != 2)
		return fail(test, "queue plain and rights-bearing ranges");
	if (close(first_pipe[0]) < 0 || close(second_pipe[0]) < 0)
		return fail(test, "close sender descriptor aliases");
	first_pipe[0] = second_pipe[0] = -1;

	char data[16];
	struct received_message received;
	if (receive_message(carrier[1], data, 6, 1,
	                    MSG_WAITALL | MSG_DONTWAIT,
	                    &received) < 0)
		return fail(test, "receive plain prefix and first carrier");
	if (received.length != 3 || memcmp(data, "AAB", 3) != 0 ||
	    received.fd_count != 1)
		return fail(test, "first receive crossed its byte-range barrier");
	if (expect_pipe_byte(received.fds[0], first_pipe[1], '1') < 0)
		return fail(test, "first rights batch was not associated with B");
	close(received.fds[0]);
	close(first_pipe[1]);
	first_pipe[1] = -1;

	if (receive_message(carrier[1], data, sizeof(data), 1, MSG_DONTWAIT,
	                    &received) < 0)
		return fail(test, "receive consecutive carrier");
	if (received.length != 1 || data[0] != 'C' || received.fd_count != 1)
		return fail(test, "consecutive rights batches were coalesced");
	if (expect_pipe_byte(received.fds[0], second_pipe[1], '2') < 0)
		return fail(test, "second rights batch was not associated with C");
	close(received.fds[0]);
	close(second_pipe[1]);
	second_pipe[1] = -1;

	memset(data, 0, sizeof(data));
	if (recv(carrier[1], data, sizeof(data), MSG_DONTWAIT) != 2 ||
	    memcmp(data, "DD", 2) != 0)
		return fail(test, "plain suffix was not left after both barriers");
	close_pair(carrier);

	if (socketpair(AF_UNIX, SOCK_STREAM, 0, carrier) < 0 ||
	    pipe(first_pipe) < 0 || pipe(second_pipe) < 0)
		return fail(test, "ordinary-read setup");
	if (send_rights(carrier[0], "X", 1, &first_pipe[0], 1) != 1 ||
	    send_rights(carrier[0], "Y", 1, &second_pipe[0], 1) != 1)
		return fail(test, "ordinary-read queue");
	close(first_pipe[0]);
	close(second_pipe[0]);
	first_pipe[0] = second_pipe[0] = -1;

	memset(data, 0, sizeof(data));
	if (read(carrier[1], data, sizeof(data)) != 1 || data[0] != 'X')
		return fail(test, "ordinary read did not stop at first barrier");
	errno = 0;
	if (write(first_pipe[1], "x", 1) != -1 || errno != EPIPE)
		return fail(test, "ordinary read did not discard first rights batch");
	close(first_pipe[1]);
	first_pipe[1] = -1;

	if (receive_message(carrier[1], data, sizeof(data), 1, MSG_DONTWAIT,
	                    &received) < 0)
		return fail(test, "receive after ordinary discard");
	if (received.length != 1 || data[0] != 'Y' || received.fd_count != 1)
		return fail(test, "ordinary read left stale rights for recvmsg");
	if (expect_pipe_byte(received.fds[0], second_pipe[1], 'y') < 0)
		return fail(test, "later rights batch was not preserved");
	close(received.fds[0]);
	close(second_pipe[1]);
	close_pair(carrier);

	if (socketpair(AF_UNIX, SOCK_STREAM, 0, carrier) < 0 ||
	    pipe(first_pipe) < 0)
		return fail(test, "zero-iovec stream setup");
	if (send_rights_without_iov(carrier[0], &first_pipe[0], 1) != 0)
		return fail(test, "zero-iovec stream send");
	if (poll_readable(carrier[1]) != 0)
		return fail(test, "zero-iovec stream send queued a carrier");
	close(first_pipe[0]);
	first_pipe[0] = -1;
	errno = 0;
	if (write(first_pipe[1], "x", 1) != -1 || errno != EPIPE)
		return fail(test, "zero-iovec stream send retained rights");
	close(first_pipe[1]);
	first_pipe[1] = -1;

	int invalid_fd = INT_MAX;
	errno = 0;
	if (send_rights_without_iov(carrier[0], &invalid_fd, 1) != -1 ||
	    errno != EBADF)
		return fail(test, "zero-iovec stream send skipped control validation");
	if (poll_readable(carrier[1]) != 0)
		return fail(test, "invalid zero-iovec stream send queued data");
	close_pair(carrier);

	puts("SCM_RIGHTS_STREAM_BARRIER_PASS");
	return 0;
}

static int test_stream_peek(void)
{
	static const char *const test = "stream MSG_PEEK";
	int carrier[2] = { -1, -1 };
	int data_pipe[2] = { -1, -1 };
	if (socketpair(AF_UNIX, SOCK_STREAM, 0, carrier) < 0 ||
	    pipe(data_pipe) < 0)
		return fail(test, "setup");
	if (send_rights(carrier[0], "P", 1, &data_pipe[0], 1) != 1 ||
	    close(data_pipe[0]) < 0)
		return fail(test, "queue rights");
	data_pipe[0] = -1;

	char byte = 0;
	struct received_message received;
	if (receive_message(carrier[1], &byte, 1, 0,
	                    MSG_PEEK | MSG_DONTWAIT, &received) < 0)
		return fail(test, "peek without control");
	if (received.length != 1 || byte != 'P' ||
	    (received.flags & MSG_CTRUNC) == 0 || received.fd_count != 0)
		return fail(test, "control-less peek did not report truncation");
	if (peek_with_short_control(carrier[1], 'P') < 0)
		return fail(test, "short-control peek did not preserve the message");

	int peeked[2] = { -1, -1 };
	for (size_t i = 0; i < ARRAY_LENGTH(peeked); ++i) {
		if (receive_message(carrier[1], &byte, 1, 1,
		                    MSG_PEEK | MSG_DONTWAIT, &received) < 0)
			return fail(test, "repeated peek");
		if (received.length != 1 || byte != 'P' || received.fd_count != 1 ||
		    fcntl(received.fds[0], F_GETFD) < 0)
			return fail(test, "peek did not install a valid descriptor");
		peeked[i] = received.fds[0];
	}
	if (peeked[0] == peeked[1])
		return fail(test, "repeated peek reused one descriptor");

	if (receive_message(carrier[1], &byte, 1, 1, MSG_DONTWAIT,
	                    &received) < 0)
		return fail(test, "normal receive after peeks");
	if (received.length != 1 || byte != 'P' || received.fd_count != 1 ||
	    received.fds[0] == peeked[0] || received.fds[0] == peeked[1])
		return fail(test, "normal receive did not install a third descriptor");
	if (expect_empty_nonblocking(carrier[1]) < 0)
		return fail(test, "normal receive did not consume queued message");

	close(peeked[0]);
	close(peeked[1]);
	close(received.fds[0]);
	close(data_pipe[1]);
	close_pair(carrier);
	puts("SCM_RIGHTS_STREAM_PEEK_PASS");
	return 0;
}

static int poll_readable(int fd)
{
	struct pollfd descriptor = {
		.fd = fd,
		.events = POLLIN,
	};
	int result = poll(&descriptor, 1, 0);
	if (result < 0)
		return -1;
	return result == 1 && (descriptor.revents & POLLIN) != 0;
}

static int make_unix_datagram_endpoints(int pair[2], const char *label,
	                                    int connect_sender,
	                                    struct sockaddr_un *destination,
	                                    socklen_t *destination_len)
{
	static unsigned int sequence;
	pair[0] = pair[1] = -1;
	int receiver = socket(AF_UNIX, SOCK_DGRAM, 0);
	if (receiver < 0)
		return -1;

	struct sockaddr_un address;
	memset(&address, 0, sizeof(address));
	address.sun_family = AF_UNIX;
	int written = snprintf(address.sun_path + 1, sizeof(address.sun_path) - 1,
	                       "kandelo-scm-%s-%ld-%u", label, (long) getpid(),
	                       sequence++);
	if (written < 0 || (size_t) written >= sizeof(address.sun_path) - 1) {
		close(receiver);
		errno = ENAMETOOLONG;
		return -1;
	}
	socklen_t address_len =
		(socklen_t) (offsetof(struct sockaddr_un, sun_path) + 1 +
		             (size_t) written);
	if (bind(receiver, (struct sockaddr *) &address, address_len) < 0) {
		close(receiver);
		return -1;
	}

	int sender = socket(AF_UNIX, SOCK_DGRAM, 0);
	if (sender < 0 ||
	    (connect_sender &&
	     connect(sender, (struct sockaddr *) &address, address_len) < 0)) {
		if (sender >= 0)
			close(sender);
		close(receiver);
		return -1;
	}
	if (destination)
		*destination = address;
	if (destination_len)
		*destination_len = address_len;
	pair[0] = sender;
	pair[1] = receiver;
	return 0;
}

static int make_unix_datagram_pair(int pair[2], const char *label)
{
	return make_unix_datagram_endpoints(pair, label, 1, NULL, NULL);
}

static int test_datagram_rights(void)
{
	static const char *const test = "AF_UNIX datagram rights";
	int carrier[2] = { -1, -1 };
	int addressed[2] = { -1, -1 };
	int data_pipe[2] = { -1, -1 };
	if (make_unix_datagram_pair(carrier, "rights") < 0 ||
	    pipe(data_pipe) < 0)
		return fail(test, "setup");

	if (send_rights(carrier[0], "D", 1, &data_pipe[0], 1) != 1 ||
	    close(data_pipe[0]) < 0)
		return fail(test, "send nonempty datagram");
	data_pipe[0] = -1;
	char byte = 0;
	struct received_message received;
	if (receive_message(carrier[1], &byte, 1, 1, MSG_DONTWAIT,
	                    &received) < 0)
		return fail(test, "receive nonempty datagram");
	if (received.length != 1 || byte != 'D' || received.fd_count != 1 ||
	    expect_pipe_byte(received.fds[0], data_pipe[1], 'd') < 0)
		return fail(test, "nonempty datagram lost its rights");
	close(received.fds[0]);
	close(data_pipe[1]);

	struct sockaddr_un destination;
	socklen_t destination_len = 0;
	if (make_unix_datagram_endpoints(addressed, "addressed", 0,
	                                 &destination, &destination_len) < 0 ||
	    pipe(data_pipe) < 0)
		return fail(test, "addressed datagram setup");
	if (send_rights_to(addressed[0], "A", 1, &data_pipe[0], 1,
	                   (struct sockaddr *) &destination,
	                   destination_len) != 1 ||
	    close(data_pipe[0]) < 0)
		return fail(test, "send addressed rights datagram");
	data_pipe[0] = -1;
	if (receive_message(addressed[1], &byte, 1, 1, MSG_DONTWAIT,
	                    &received) < 0)
		return fail(test, "receive addressed rights datagram");
	if (received.length != 1 || byte != 'A' || received.fd_count != 1 ||
	    expect_pipe_byte(received.fds[0], data_pipe[1], 'a') < 0)
		return fail(test, "addressed datagram lost its rights");
	close(received.fds[0]);
	close(data_pipe[1]);
	close_pair(addressed);

	if (pipe(data_pipe) < 0)
		return fail(test, "zero datagram pipe");
	if (send_rights(carrier[0], "", 0, &data_pipe[0], 1) != 0 ||
	    close(data_pipe[0]) < 0)
		return fail(test, "send zero-byte rights datagram");
	data_pipe[0] = -1;
	if (poll_readable(carrier[1]) != 1)
		return fail(test, "zero-byte datagram was not readable");
	if (receive_message(carrier[1], &byte, 0, 1, MSG_DONTWAIT,
	                    &received) < 0)
		return fail(test, "receive zero-byte rights datagram");
	if (received.length != 0 || received.fd_count != 1 ||
	    expect_pipe_byte(received.fds[0], data_pipe[1], 'z') < 0)
		return fail(test, "zero-byte datagram lost its rights");
	if (poll_readable(carrier[1]) != 0)
		return fail(test, "zero-byte datagram was not consumed");
	close(received.fds[0]);
	close(data_pipe[1]);

	if (pipe(data_pipe) < 0)
		return fail(test, "zero-iovec datagram pipe");
	if (send_rights_without_iov(carrier[0], &data_pipe[0], 1) != 0 ||
	    close(data_pipe[0]) < 0)
		return fail(test, "send zero-iovec rights datagram");
	data_pipe[0] = -1;
	if (poll_readable(carrier[1]) != 1)
		return fail(test, "zero-iovec datagram was not readable");
	if (receive_message_without_iov(carrier[1], 1, MSG_DONTWAIT,
	                                &received) < 0)
		return fail(test, "receive zero-iovec rights datagram");
	if (received.length != 0 || received.fd_count != 1 ||
	    expect_pipe_byte(received.fds[0], data_pipe[1], 'i') < 0)
		return fail(test, "zero-iovec datagram lost its rights");
	if (poll_readable(carrier[1]) != 0)
		return fail(test, "zero-iovec datagram was not consumed");
	close(received.fds[0]);
	close(data_pipe[1]);

	if (pipe(data_pipe) < 0)
		return fail(test, "peek datagram pipe");
	if (send_rights(carrier[0], "Q", 1, &data_pipe[0], 1) != 1 ||
	    close(data_pipe[0]) < 0)
		return fail(test, "send peek datagram");
	data_pipe[0] = -1;

	int peeked[2] = { -1, -1 };
	for (size_t i = 0; i < ARRAY_LENGTH(peeked); ++i) {
		if (receive_message(carrier[1], &byte, 1, 1,
		                    MSG_PEEK | MSG_DONTWAIT, &received) < 0)
			return fail(test, "repeated datagram peek");
		if (received.length != 1 || byte != 'Q' || received.fd_count != 1 ||
		    fcntl(received.fds[0], F_GETFD) < 0)
			return fail(test, "datagram peek descriptor");
		peeked[i] = received.fds[0];
	}
	if (peeked[0] == peeked[1])
		return fail(test, "datagram peeks reused one descriptor");
	if (receive_message(carrier[1], &byte, 1, 1, MSG_DONTWAIT,
	                    &received) < 0)
		return fail(test, "consume peeked datagram");
	if (received.length != 1 || byte != 'Q' || received.fd_count != 1 ||
	    received.fds[0] == peeked[0] || received.fds[0] == peeked[1])
		return fail(test, "datagram normal receive descriptor");
	if (expect_empty_nonblocking(carrier[1]) < 0)
		return fail(test, "peeked datagram was not consumed once");

	close(peeked[0]);
	close(peeked[1]);
	close(received.fds[0]);
	close(data_pipe[1]);
	close_pair(carrier);
	puts("SCM_RIGHTS_DGRAM_ZERO_AND_PEEK_PASS");
	return 0;
}

static int receive_scatter(int socket_fd, int flags, ssize_t expected_length,
	                       int expect_trunc)
{
	char first[2] = { '?', 'A' };
	char second[3] = { '?', '?', 'B' };
	struct iovec iov[2] = {
		{ .iov_base = first, .iov_len = 1 },
		{ .iov_base = second, .iov_len = 2 },
	};
	struct msghdr message;
	memset(&message, 0, sizeof(message));
	message.msg_iov = iov;
	message.msg_iovlen = ARRAY_LENGTH(iov);
	ssize_t result = recvmsg(socket_fd, &message, flags);
	if (result != expected_length || first[0] != 'a' || second[0] != 'b' ||
	    second[1] != 'c' || first[1] != 'A' || second[2] != 'B' ||
	    ((message.msg_flags & MSG_TRUNC) != 0) != expect_trunc) {
		errno = EIO;
		return -1;
	}
	return 0;
}

static int receive_zero_capacity(int socket_fd, int flags,
	                             ssize_t expected_length)
{
	char guard = 'G';
	struct iovec iov = {
		.iov_base = &guard,
		.iov_len = 0,
	};
	struct msghdr message;
	memset(&message, 0, sizeof(message));
	message.msg_iov = &iov;
	message.msg_iovlen = 1;
	ssize_t result = recvmsg(socket_fd, &message, flags);
	if (result != expected_length || guard != 'G' ||
	    (message.msg_flags & MSG_TRUNC) == 0) {
		errno = EIO;
		return -1;
	}
	return 0;
}

static int test_datagram_truncation(void)
{
	static const char *const test = "datagram MSG_TRUNC";
	int carrier[2] = { -1, -1 };
	if (make_unix_datagram_pair(carrier, "trunc") < 0)
		return fail(test, "setup");

	if (send(carrier[0], "abcdef", 6, 0) != 6 ||
	    receive_scatter(carrier[1], 0, 3, 1) < 0)
		return fail(test, "output MSG_TRUNC without input flag");
	if (send(carrier[0], "abcdef", 6, 0) != 6 ||
	    receive_scatter(carrier[1], MSG_TRUNC, 6, 1) < 0)
		return fail(test, "input MSG_TRUNC full-length return");
	if (send(carrier[0], "abc", 3, 0) != 3 ||
	    receive_scatter(carrier[1], 0, 3, 0) < 0)
		return fail(test, "exact-capacity datagram");
	if (send(carrier[0], "wxyz", 4, 0) != 4 ||
	    receive_zero_capacity(carrier[1], 0, 0) < 0)
		return fail(test, "zero-capacity output MSG_TRUNC");
	if (send(carrier[0], "wxyz", 4, 0) != 4 ||
	    receive_zero_capacity(carrier[1], MSG_TRUNC, 4) < 0)
		return fail(test, "zero-capacity full-length MSG_TRUNC");

	close_pair(carrier);
	puts("SCM_RIGHTS_DGRAM_TRUNC_PASS");
	return 0;
}

static int receive_cloexec_descriptors(int *cloexec_fd, int *plain_fd)
{
	static const char *const test = "MSG_CMSG_CLOEXEC";
	int carrier[2] = { -1, -1 };
	int cloexec_pipe[2] = { -1, -1 };
	int plain_pipe[2] = { -1, -1 };
	if (socketpair(AF_UNIX, SOCK_STREAM, 0, carrier) < 0 ||
	    pipe(cloexec_pipe) < 0 || pipe(plain_pipe) < 0)
		return fail(test, "setup");
	if (send_rights(carrier[0], "C", 1, &cloexec_pipe[0], 1) != 1 ||
	    send_rights(carrier[0], "N", 1, &plain_pipe[0], 1) != 1)
		return fail(test, "queue descriptors");
	close(cloexec_pipe[0]);
	close(plain_pipe[0]);
	cloexec_pipe[0] = plain_pipe[0] = -1;

	char byte = 0;
	struct received_message received;
	if (receive_message(carrier[1], &byte, 1, 1,
	                    MSG_CMSG_CLOEXEC | MSG_DONTWAIT, &received) < 0)
		return fail(test, "receive CLOEXEC descriptor");
	if (received.length != 1 || byte != 'C' || received.fd_count != 1 ||
	    (received.flags & MSG_CMSG_CLOEXEC) == 0)
		return fail(test, "CLOEXEC receive flags");
	int fd_flags = fcntl(received.fds[0], F_GETFD);
	if (fd_flags < 0 || (fd_flags & FD_CLOEXEC) == 0)
		return fail(test, "received descriptor was visible without CLOEXEC");
	*cloexec_fd = received.fds[0];

	if (receive_message(carrier[1], &byte, 1, 1, MSG_DONTWAIT,
	                    &received) < 0)
		return fail(test, "receive plain descriptor");
	if (received.length != 1 || byte != 'N' || received.fd_count != 1 ||
	    (received.flags & MSG_CMSG_CLOEXEC) != 0)
		return fail(test, "plain receive flags");
	fd_flags = fcntl(received.fds[0], F_GETFD);
	if (fd_flags < 0 || (fd_flags & FD_CLOEXEC) != 0)
		return fail(test, "plain received descriptor gained CLOEXEC");
	*plain_fd = received.fds[0];

	if (send(carrier[0], "Z", 1, 0) != 1 ||
	    receive_message(carrier[1], &byte, 1, 1,
	                    MSG_CMSG_CLOEXEC | MSG_DONTWAIT, &received) < 0)
		return fail(test, "CLOEXEC receive without rights");
	if (received.length != 1 || byte != 'Z' || received.fd_count != 0 ||
	    (received.flags & MSG_CMSG_CLOEXEC) == 0)
		return fail(test, "CLOEXEC input flag was not reflected on output");

	close(cloexec_pipe[1]);
	close(plain_pipe[1]);
	close_pair(carrier);
	puts("SCM_RIGHTS_CLOEXEC_FLAG_PASS");
	return 0;
}

static int bind_loopback_socket(int fd, int family)
{
	if (family == AF_INET) {
		struct sockaddr_in address;
		memset(&address, 0, sizeof(address));
		address.sin_family = AF_INET;
		address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
		address.sin_port = 0;
		return bind(fd, (struct sockaddr *) &address, sizeof(address));
	}
	struct sockaddr_in6 address;
	memset(&address, 0, sizeof(address));
	address.sin6_family = AF_INET6;
	address.sin6_addr = in6addr_loopback;
	address.sin6_port = 0;
	return bind(fd, (struct sockaddr *) &address, sizeof(address));
}

static int connect_bound_socket(int fd, int bound_fd, int family)
{
	if (family == AF_INET) {
		struct sockaddr_in address;
		socklen_t length = sizeof(address);
		memset(&address, 0, sizeof(address));
		if (getsockname(bound_fd, (struct sockaddr *) &address, &length) < 0)
			return -1;
		return connect(fd, (struct sockaddr *) &address, length);
	}
	struct sockaddr_in6 address;
	socklen_t length = sizeof(address);
	memset(&address, 0, sizeof(address));
	if (getsockname(bound_fd, (struct sockaddr *) &address, &length) < 0)
		return -1;
	return connect(fd, (struct sockaddr *) &address, length);
}

static int make_nonunix_pair(int family, int type, int pair[2])
{
	pair[0] = pair[1] = -1;
	int bound = socket(family, type, 0);
	if (bound < 0 || bind_loopback_socket(bound, family) < 0)
		goto error;
	if (type == SOCK_DGRAM) {
		int sender = socket(family, type, 0);
		if (sender < 0 || connect_bound_socket(sender, bound, family) < 0) {
			if (sender >= 0)
				close(sender);
			goto error;
		}
		pair[0] = sender;
		pair[1] = bound;
		return 0;
	}

	if (listen(bound, 1) < 0)
		goto error;
	int sender = socket(family, type, 0);
	if (sender < 0 || connect_bound_socket(sender, bound, family) < 0) {
		if (sender >= 0)
			close(sender);
		goto error;
	}
	int receiver = accept(bound, NULL, NULL);
	if (receiver < 0) {
		close(sender);
		goto error;
	}
	close(bound);
	pair[0] = sender;
	pair[1] = receiver;
	return 0;

error:
	if (bound >= 0)
		close(bound);
	return -1;
}

static int expect_nonunix_rights_rejected(int family, int type)
{
	int sockets[2] = { -1, -1 };
	int data_pipe[2] = { -1, -1 };
	if (make_nonunix_pair(family, type, sockets) < 0 || pipe(data_pipe) < 0)
		return -1;

	errno = 0;
	ssize_t sent = send_rights(sockets[0], "N", 1, &data_pipe[0], 1);
	int send_errno = errno;
	if (sent != -1 || send_errno != EINVAL) {
		errno = send_errno;
		return -1;
	}
	if (expect_empty_nonblocking(sockets[1]) < 0)
		return -1;

	close(data_pipe[0]);
	data_pipe[0] = -1;
	errno = 0;
	if (write(data_pipe[1], "x", 1) != -1 || errno != EPIPE)
		return -1;
	close(data_pipe[1]);
	close_pair(sockets);
	return 0;
}

static int test_unrepresentable_descriptor_rejection(void)
{
	static const char *const test = "unrepresentable SCM_RIGHTS descriptor";
	int carrier[2] = { -1, -1 };
	int invalid[4] = { -1, -1, -1, -1 };
	int data_pipe[2] = { -1, -1 };
	if (socketpair(AF_UNIX, SOCK_STREAM, 0, carrier) < 0)
		return fail(test, "carrier socketpair");
	/*
	 * The carrier peer is itself a connected AF_UNIX stream descriptor.
	 * Include unbound datagram and non-Unix sockets too: transferability is
	 * rejected for every socket family, type, and state, not a narrow cycle.
	 */
	invalid[0] = carrier[1];
	invalid[1] = socket(AF_UNIX, SOCK_DGRAM, 0);
	invalid[2] = socket(AF_INET, SOCK_DGRAM, 0);
	invalid[3] = socket(AF_INET6, SOCK_STREAM, 0);
	if (invalid[1] < 0 || invalid[2] < 0 || invalid[3] < 0)
		return fail(test, "invalid descriptor setup");

	for (size_t i = 0; i < ARRAY_LENGTH(invalid); ++i) {
		char byte = (char) ('a' + i);
		errno = 0;
		ssize_t sent = send_rights(carrier[0], &byte, 1, &invalid[i], 1);
		int send_errno = errno;
		if (sent != -1 || send_errno != EOPNOTSUPP) {
			errno = send_errno;
			return fail(test, "lossy descriptor was accepted");
		}
		if (expect_empty_nonblocking(carrier[1]) < 0)
			return fail(test, "rejection published carrier data or rights");
	}

	/*
	 * The same channel must remain usable for a supported right. Receiving
	 * this pipe as the first message proves none of the rejected socket
	 * descriptors left a hidden control record or carrier byte behind.
	 */
	if (pipe(data_pipe) < 0 ||
	    send_rights(carrier[0], "P", 1, &data_pipe[0], 1) != 1)
		return fail(test, "supported descriptor after rejection");
	close(data_pipe[0]);
	data_pipe[0] = -1;
	char byte = 0;
	struct received_message received;
	if (receive_message(carrier[1], &byte, 1, 1, 0, &received) < 0 ||
	    received.length != 1 || byte != 'P' || received.fd_count != 1 ||
	    expect_pipe_byte(received.fds[0], data_pipe[1], 'R') < 0)
		return fail(test, "supported descriptor was not first in queue");

	close(received.fds[0]);
	close(data_pipe[1]);
	for (size_t i = 1; i < ARRAY_LENGTH(invalid); ++i)
		close(invalid[i]);
	close_pair(carrier);
	puts("SCM_RIGHTS_UNREPRESENTABLE_REJECTION_PASS");
	return 0;
}

static int test_stream_zero_iov_preserves_message(void)
{
	static const char *const test = "zero-iovec AF_UNIX stream recvmsg";
	int carrier[2] = { -1, -1 };
	int data_pipe[2] = { -1, -1 };
	if (socketpair(AF_UNIX, SOCK_STREAM, 0, carrier) < 0 ||
	    pipe(data_pipe) < 0 ||
	    send_rights(carrier[0], "Z", 1, &data_pipe[0], 1) != 1)
		return fail(test, "setup");

	struct received_message empty;
	if (receive_message_without_iov(carrier[1], 1, MSG_DONTWAIT, &empty) < 0 ||
	    empty.length != 0 || empty.fd_count != 0)
		return fail(test, "zero-iovec receive did not return empty");

	char byte = 0;
	struct received_message received;
	if (receive_message(carrier[1], &byte, 1, 1, MSG_DONTWAIT, &received) < 0 ||
	    received.length != 1 || byte != 'Z' || received.fd_count != 1 ||
	    expect_pipe_byte(received.fds[0], data_pipe[1], 'I') < 0)
		return fail(test, "zero-iovec receive consumed bytes or rights");

	close(received.fds[0]);
	close_pair(data_pipe);
	close_pair(carrier);
	puts("SCM_RIGHTS_STREAM_ZERO_IOV_PASS");
	return 0;
}

static int test_nonunix_rejection(void)
{
	static const char *const test = "non-AF_UNIX SCM_RIGHTS";
	const int families[] = { AF_INET, AF_INET6 };
	const int types[] = { SOCK_STREAM, SOCK_DGRAM };
	for (size_t family = 0; family < ARRAY_LENGTH(families); ++family) {
		for (size_t type = 0; type < ARRAY_LENGTH(types); ++type) {
			if (expect_nonunix_rights_rejected(families[family],
			                                  types[type]) < 0)
				return fail(test, "rights were accepted or data was sent");
		}
	}
	puts("SCM_RIGHTS_NON_UNIX_REJECTION_PASS");
	return 0;
}

static int parse_fd(const char *text)
{
	char *end = NULL;
	errno = 0;
	long value = strtol(text, &end, 10);
	if (errno != 0 || end == text || *end != '\0' || value < 0 ||
	    value > 0x7fffffffL) {
		errno = EINVAL;
		return -1;
	}
	return (int) value;
}

static int post_exec_probe(const char *cloexec_text, const char *plain_text)
{
	static const char *const test = "post-exec CLOEXEC";
	int cloexec_fd = parse_fd(cloexec_text);
	int plain_fd = parse_fd(plain_text);
	if (cloexec_fd < 0 || plain_fd < 0)
		return fail(test, "invalid descriptor argument");

	errno = 0;
	if (fcntl(cloexec_fd, F_GETFD) != -1 || errno != EBADF)
		return fail(test, "CLOEXEC received descriptor survived exec");
	int flags = fcntl(plain_fd, F_GETFD);
	if (flags < 0 || (flags & FD_CLOEXEC) != 0)
		return fail(test, "plain received descriptor did not survive exec");
	close(plain_fd);
	alarm(0);
	puts("SCM_RIGHTS_CLOEXEC_EXEC_PASS");
	puts("SCM_RIGHTS_SEMANTICS_PASS");
	return 0;
}

static int run_cloexec_case(void)
{
	int cloexec_fd = -1;
	int plain_fd = -1;
	if (receive_cloexec_descriptors(&cloexec_fd, &plain_fd) < 0)
		return -1;

	char cloexec_text[32];
	char plain_text[32];
	snprintf(cloexec_text, sizeof(cloexec_text), "%d", cloexec_fd);
	snprintf(plain_text, sizeof(plain_text), "%d", plain_fd);
	char *const exec_argv[] = {
		(char *) self_path,
		"--exec-probe",
		cloexec_text,
		plain_text,
		NULL,
	};
	char *const exec_env[] = { NULL };
	fflush(NULL);
	execve(self_path, exec_argv, exec_env);
	return fail("MSG_CMSG_CLOEXEC", "self exec");
}

static int run_named_case(const char *name)
{
	if (strcmp(name, "stream") == 0)
		return test_stream_barriers();
	if (strcmp(name, "peek") == 0)
		return test_stream_peek();
	if (strcmp(name, "datagram") == 0)
		return test_datagram_rights();
	if (strcmp(name, "trunc") == 0)
		return test_datagram_truncation();
	if (strcmp(name, "domain") == 0)
		return test_nonunix_rejection();
	if (strcmp(name, "representability") == 0)
		return test_unrepresentable_descriptor_rejection();
	if (strcmp(name, "zero-iov-stream") == 0)
		return test_stream_zero_iov_preserves_message();
	if (strcmp(name, "cloexec") == 0)
		return run_cloexec_case();
	errno = EINVAL;
	return fail("SCM_RIGHTS case", "unknown case");
}

int main(int argc, char **argv)
{
	signal(SIGPIPE, SIG_IGN);
	alarm(30);
	if (argc == 4 && strcmp(argv[1], "--exec-probe") == 0)
		return post_exec_probe(argv[2], argv[3]) == 0 ? 0 : 90;
	if (argc == 3 && strcmp(argv[1], "--case") == 0)
		return run_named_case(argv[2]) == 0 ? 0 : 80;
	if (argc != 1)
		return fail("SCM_RIGHTS semantics", "invalid arguments") == 0 ? 0 : 2;

	if (test_stream_barriers() < 0 || test_stream_peek() < 0 ||
	    test_datagram_rights() < 0 || test_datagram_truncation() < 0 ||
	    test_nonunix_rejection() < 0 ||
	    test_unrepresentable_descriptor_rejection() < 0 ||
	    test_stream_zero_iov_preserves_message() < 0)
		return 1;
	return run_cloexec_case() == 0 ? 0 : 1;
}
