/*
 * AF_UNIX datagrams are reliable: a full receive queue must make a
 * nonblocking sender report EAGAIN without discarding or reordering messages.
 */

#include "udp.h"

#include <pthread.h>
#include <stddef.h>
#include <stdint.h>
#include <stdatomic.h>
#include <sys/epoll.h>
#include <sys/select.h>
#include <sys/un.h>
#include <time.h>

struct blocking_send_context
{
	int fd;
	uint32_t payload;
	_Atomic int started;
	_Atomic int done;
	ssize_t result;
	int errnum;
};

struct blocking_poll_context
{
	int fd;
	_Atomic int started;
	_Atomic int done;
	int result;
	short revents;
	int errnum;
};

static void* blocking_send_thread(void* context_ptr)
{
	struct blocking_send_context* context = context_ptr;
	atomic_store_explicit(&context->started, 1, memory_order_release);
	errno = 0;
	context->result = send(context->fd,
	                       &context->payload,
	                       sizeof(context->payload),
	                       MSG_NOSIGNAL);
	context->errnum = errno;
	atomic_store_explicit(&context->done, 1, memory_order_release);
	return NULL;
}

static void* blocking_poll_thread(void* context_ptr)
{
	struct blocking_poll_context* context = context_ptr;
	struct pollfd pfd = { .fd = context->fd, .events = POLLOUT, .revents = 0 };
	atomic_store_explicit(&context->started, 1, memory_order_release);
	errno = 0;
	context->result = poll(&pfd, 1, 1000);
	context->errnum = errno;
	context->revents = pfd.revents;
	atomic_store_explicit(&context->done, 1, memory_order_release);
	return NULL;
}

static void wait_for_thread_start(_Atomic int* started, const char* operation)
{
	for ( int attempt = 0; attempt < 2000; attempt++ )
	{
		if ( atomic_load_explicit(started, memory_order_acquire) )
			return;
		usleep(1000);
	}
	errx(1, "%s thread did not start", operation);
}

static void join_thread(pthread_t thread, const char* operation)
{
	int error = pthread_join(thread, NULL);
	if ( error )
	{
		errno = error;
		err(1, "join %s thread", operation);
	}
}

int main(void)
{
	const char* recv_path = "/tmp/kandelo-unix-dgram-overflow-recv.sock";
	const char* send_path = "/tmp/kandelo-unix-dgram-overflow-send.sock";
	if ( unlink(recv_path) < 0 && errno != ENOENT )
		err(1, "unlink receiver before bind");
	if ( unlink(send_path) < 0 && errno != ENOENT )
		err(1, "unlink sender before bind");

	int recv_fd = socket(AF_UNIX, SOCK_DGRAM, 0);
	if ( recv_fd < 0 )
		err(1, "receiver socket");

	struct sockaddr_un recv_addr;
	memset(&recv_addr, 0, sizeof(recv_addr));
	recv_addr.sun_family = AF_UNIX;
	strncpy(recv_addr.sun_path, recv_path, sizeof(recv_addr.sun_path) - 1);
	socklen_t recv_addr_len =
		(socklen_t) (offsetof(struct sockaddr_un, sun_path) +
		             strlen(recv_addr.sun_path) + 1);
	if ( bind(recv_fd,
	           (const struct sockaddr*) &recv_addr,
	           recv_addr_len) < 0 )
		err(1, "receiver bind");

	int send_fd = socket(AF_UNIX, SOCK_DGRAM, 0);
	if ( send_fd < 0 )
		err(1, "sender socket");
	struct sockaddr_un send_addr;
	memset(&send_addr, 0, sizeof(send_addr));
	send_addr.sun_family = AF_UNIX;
	strncpy(send_addr.sun_path, send_path, sizeof(send_addr.sun_path) - 1);
	socklen_t send_addr_len =
		(socklen_t) (offsetof(struct sockaddr_un, sun_path) +
		             strlen(send_addr.sun_path) + 1);
	if ( bind(send_fd,
	           (const struct sockaddr*) &send_addr,
	           send_addr_len) < 0 )
		err(1, "sender bind");
	if ( connect(send_fd,
	             (const struct sockaddr*) &recv_addr,
	             recv_addr_len) < 0 )
		err(1, "sender connect");

	int attacker_fd = socket(AF_UNIX, SOCK_DGRAM, 0);
	if ( attacker_fd < 0 )
		err(1, "attacker socket");
	if ( connect(attacker_fd,
	             (const struct sockaddr*) &recv_addr,
	             recv_addr_len) < 0 )
		err(1, "attacker pre-connect connect");
	const char attacker_payload[] = "attacker-before-connect";
	if ( send(attacker_fd,
	          attacker_payload,
	          sizeof(attacker_payload) - 1,
	          0) != (ssize_t) (sizeof(attacker_payload) - 1) )
		err(1, "attacker pre-connect send");
	const char peer_payload[] = "peer-before-connect";
	if ( send(send_fd, peer_payload, sizeof(peer_payload) - 1, 0) !=
	     (ssize_t) (sizeof(peer_payload) - 1) )
		err(1, "peer pre-connect send");

	if ( connect(recv_fd,
	             (const struct sockaddr*) &send_addr,
	             send_addr_len) < 0 )
		err(1, "receiver connect");
	char preconnect_buf[32];
	ssize_t preconnect_amount =
		recv(recv_fd, preconnect_buf, sizeof(preconnect_buf), MSG_DONTWAIT);
	if ( preconnect_amount != (ssize_t) (sizeof(peer_payload) - 1) ||
	     memcmp(preconnect_buf, peer_payload, sizeof(peer_payload) - 1) != 0 )
		errx(1, "receiver did not preserve only its selected peer's datagram");

	errno = 0;
	if ( connect(attacker_fd,
	             (const struct sockaddr*) &recv_addr,
	             recv_addr_len) != -1 )
		errx(1, "attacker connect unexpectedly succeeded");
	if ( errno != EPERM )
		err(1, "attacker connect to connected receiver");
	errno = 0;
	if ( sendto(attacker_fd,
	            attacker_payload,
	            sizeof(attacker_payload) - 1,
	            0,
	            (const struct sockaddr*) &recv_addr,
	            recv_addr_len) != -1 )
		errx(1, "attacker send unexpectedly succeeded");
	if ( errno != EPERM )
		err(1, "attacker send to connected receiver");

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
	// The receiver selected send_fd while attacker_fd was already connected.
	// Even though the selected peer keeps the queue full, the rejected sender
	// is writable because its next send now has an immediate EPERM result.
	struct pollfd rejected_pfd = {
		.fd = attacker_fd,
		.events = POLLOUT,
		.revents = 0,
	};
	if ( poll(&rejected_pfd, 1, 0) != 1 ||
	     !(rejected_pfd.revents & POLLOUT) )
		errx(1,
		     "rejected full-queue sender remained blocked: revents=%#x",
		     rejected_pfd.revents);
	errno = 0;
	if ( send(attacker_fd,
	          attacker_payload,
	          sizeof(attacker_payload) - 1,
	          0) != -1 )
		errx(1, "rejected connected sender unexpectedly succeeded");
	if ( errno != EPERM )
		err(1, "rejected connected sender");

	struct pollfd pfd = { .fd = send_fd, .events = POLLOUT, .revents = 0 };
	if ( poll(&pfd, 1, 0) != 0 || pfd.revents != 0 )
		errx(1, "full peer unexpectedly writable: revents=%#x", pfd.revents);

	// Finite readiness waits must keep one absolute deadline and perform a
	// final readiness check instead of restarting their timeout on each retry.
	pfd.revents = 0;
	if ( poll(&pfd, 1, 120) != 0 || pfd.revents != 0 )
		errx(1, "finite poll reported full peer writable: revents=%#x", pfd.revents);
	fd_set writefds;
	FD_ZERO(&writefds);
	FD_SET(send_fd, &writefds);
	struct timeval timeout = { .tv_sec = 0, .tv_usec = 120000 };
	int select_result = select(send_fd + 1, NULL, &writefds, NULL, &timeout);
	if ( select_result != 0 )
		errx(1, "finite select reported full peer writable: result=%d", select_result);
	sigset_t blocked_mask;
	sigset_t old_mask;
	sigset_t wait_mask;
	sigset_t after_mask;
	sigemptyset(&blocked_mask);
	sigaddset(&blocked_mask, SIGUSR1);
	if ( sigprocmask(SIG_BLOCK, &blocked_mask, &old_mask) < 0 )
		err(1, "block SIGUSR1");
	sigemptyset(&wait_mask);
	FD_ZERO(&writefds);
	FD_SET(send_fd, &writefds);
	struct timespec pselect_timeout = { .tv_sec = 0, .tv_nsec = 120000000 };
	int pselect_result = pselect(send_fd + 1,
	                             NULL,
	                             &writefds,
	                             NULL,
	                             &pselect_timeout,
	                             &wait_mask);
	if ( pselect_result != 0 )
		errx(1,
		     "finite pselect reported full peer writable: result=%d",
		     pselect_result);
	if ( sigprocmask(SIG_BLOCK, NULL, &after_mask) < 0 )
		err(1, "read signal mask after pselect");
	if ( sigismember(&after_mask, SIGUSR1) != 1 )
		errx(1, "pselect did not restore the pre-wait signal mask");
	if ( sigprocmask(SIG_SETMASK, &old_mask, NULL) < 0 )
		err(1, "restore signal mask");
	if ( sigprocmask(SIG_BLOCK, &blocked_mask, &old_mask) < 0 )
		err(1, "block SIGUSR1 before ppoll");
	pfd.revents = 0;
	struct timespec ppoll_timeout = { .tv_sec = 0, .tv_nsec = 120000000 };
	int ppoll_result = ppoll(&pfd, 1, &ppoll_timeout, &wait_mask);
	if ( ppoll_result != 0 )
		errx(1,
		     "finite ppoll reported full peer writable: result=%d",
		     ppoll_result);
	if ( sigprocmask(SIG_BLOCK, NULL, &after_mask) < 0 )
		err(1, "read signal mask after ppoll");
	if ( sigismember(&after_mask, SIGUSR1) != 1 )
		errx(1, "ppoll did not restore the pre-wait signal mask");
	if ( sigprocmask(SIG_SETMASK, &old_mask, NULL) < 0 )
		err(1, "restore signal mask after ppoll");
	int epoll_fd = epoll_create1(EPOLL_CLOEXEC);
	if ( epoll_fd < 0 )
		err(1, "epoll_create1");
	struct epoll_event interest = { .events = EPOLLOUT, .data.fd = send_fd };
	if ( epoll_ctl(epoll_fd, EPOLL_CTL_ADD, send_fd, &interest) < 0 )
		err(1, "epoll_ctl");
	struct epoll_event event;
	if ( epoll_wait(epoll_fd, &event, 1, 120) != 0 )
		errx(1, "finite epoll reported full peer writable");
	if ( close(epoll_fd) < 0 )
		err(1, "close epoll");

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

	// Exercise a genuinely parked blocking send through a pthread's distinct
	// syscall channel. Draining one slot must wake that sender, and the newly
	// admitted datagram must remain at the tail of the preserved queue.
	if ( fcntl(send_fd, F_SETFL, flags) < 0 )
		err(1, "restore blocking sender");
	struct timeval send_timeout = { .tv_sec = 1, .tv_usec = 0 };
	if ( setsockopt(send_fd,
	                SOL_SOCKET,
	                SO_SNDTIMEO,
	                &send_timeout,
	                sizeof(send_timeout)) < 0 )
		err(1, "set bounded sender timeout");
	const uint32_t blocking_base = 1000;
	for ( uint32_t sequence = 0; sequence < 128; sequence++ )
	{
		uint32_t blocking_payload = htobe32(blocking_base + sequence);
		if ( send(send_fd,
		          &blocking_payload,
		          sizeof(blocking_payload),
		          0) != (ssize_t) sizeof(blocking_payload) )
			err(1, "refill before blocking send at %u", sequence);
	}
	struct blocking_send_context send_context = {
		.fd = send_fd,
		.payload = htobe32(blocking_base + 128),
		.started = 0,
		.done = 0,
		.result = -1,
		.errnum = 0,
	};
	pthread_t send_thread;
	int thread_error = pthread_create(&send_thread,
	                                  NULL,
	                                  blocking_send_thread,
	                                  &send_context);
	if ( thread_error )
	{
		errno = thread_error;
		err(1, "create blocking send thread");
	}
	wait_for_thread_start(&send_context.started, "blocking send");
	usleep(20000);
	if ( atomic_load_explicit(&send_context.done, memory_order_acquire) )
		errx(1, "send to full reliable queue did not remain blocked");
	uint32_t blocking_first = 0;
	if ( recv(recv_fd,
	          &blocking_first,
	          sizeof(blocking_first),
	          MSG_DONTWAIT) != (ssize_t) sizeof(blocking_first) )
		err(1, "dequeue to wake blocked sender");
	if ( be32toh(blocking_first) != blocking_base )
		errx(1,
		     "blocking-send first sequence was %u",
		     be32toh(blocking_first));
	join_thread(send_thread, "blocking send");
	if ( send_context.result != (ssize_t) sizeof(send_context.payload) )
	{
		if ( send_context.result < 0 )
		{
			errno = send_context.errnum;
			err(1, "blocked sender did not resume after dequeue");
		}
		errx(1,
		     "blocked sender returned %zi after dequeue",
		     send_context.result);
	}
	for ( uint32_t expected = 1; expected <= 128; expected++ )
	{
		uint32_t actual = 0;
		if ( recv(recv_fd, &actual, sizeof(actual), MSG_DONTWAIT) !=
		     (ssize_t) sizeof(actual) )
			err(1, "recv blocking-send sequence %u", expected);
		if ( be32toh(actual) != blocking_base + expected )
			errx(1,
			     "blocking-send sequence %u arrived as %u",
			     blocking_base + expected,
			     be32toh(actual));
	}

	// A full reliable queue must not strand its sender after the receiver
	// shuts down reads. The sender becomes writable only to report EPIPE, and
	// MSG_NOSIGNAL must suppress the corresponding SIGPIPE delivery.
	for ( uint32_t sequence = 0; sequence < 128; sequence++ )
	{
		uint32_t shutdown_payload = htobe32(sequence);
		if ( send(send_fd,
		          &shutdown_payload,
		          sizeof(shutdown_payload),
		          0) != (ssize_t) sizeof(shutdown_payload) )
			err(1, "refill before read shutdown at %u", sequence);
	}
	pfd.revents = 0;
	if ( poll(&pfd, 1, 0) != 0 || pfd.revents != 0 )
		errx(1, "refilled peer unexpectedly writable: revents=%#x", pfd.revents);
	struct blocking_poll_context poll_context = {
		.fd = send_fd,
		.started = 0,
		.done = 0,
		.result = -1,
		.revents = 0,
		.errnum = 0,
	};
	pthread_t poll_thread;
	thread_error = pthread_create(&poll_thread,
	                              NULL,
	                              blocking_poll_thread,
	                              &poll_context);
	if ( thread_error )
	{
		errno = thread_error;
		err(1, "create blocking poll thread");
	}
	wait_for_thread_start(&poll_context.started, "blocking poll");
	usleep(20000);
	if ( atomic_load_explicit(&poll_context.done, memory_order_acquire) )
		errx(1, "POLLOUT wait on full reliable queue did not remain blocked");
	if ( shutdown(recv_fd, SHUT_RD) < 0 )
		err(1, "receiver SHUT_RD");
	join_thread(poll_thread, "blocking poll");
	if ( poll_context.result != 1 || !(poll_context.revents & POLLOUT) )
	{
		if ( poll_context.result < 0 )
		{
			errno = poll_context.errnum;
			err(1, "read shutdown failed the POLLOUT waiter");
		}
		errx(1,
		     "read shutdown did not wake POLLOUT waiter: result=%d revents=%#x",
		     poll_context.result,
		     poll_context.revents);
	}
	pfd.revents = 0;
	if ( poll(&pfd, 1, 0) != 1 || !(pfd.revents & POLLOUT) )
		errx(1, "read-shut peer did not release sender: revents=%#x", pfd.revents);
	errno = 0;
	if ( send(send_fd, &payload, sizeof(payload), MSG_NOSIGNAL) != -1 )
		errx(1, "send to read-shut peer unexpectedly succeeded");
	if ( errno != EPIPE )
		err(1, "send to read-shut peer");

	if ( close(attacker_fd) < 0 || close(send_fd) < 0 || close(recv_fd) < 0 )
		err(1, "close");
	if ( unlink(send_path) < 0 )
		err(1, "unlink sender after close");
	if ( unlink(recv_path) < 0 )
		err(1, "unlink receiver after close");
	puts("ok");
	return 0;
}
