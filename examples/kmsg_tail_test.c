/*
 * kmsg_tail_test.c — a reader at the tail of /dev/kmsg, from a real guest.
 *
 * The Rust unit tests prove what the device returns and that writing a record
 * notifies epoll waiters. What only a guest can show is the host half: that a
 * blocking read at the tail is parked and retried by the host until a record
 * arrives, that O_NONBLOCK is not parked, and that an edge-triggered epoll
 * waiter is woken by the kernel's notification.
 *
 * Usage: kmsg_tail_test MODE [POKE_DELAY_MS]
 *
 *   block     a blocking read() at the tail returns the record logged while it
 *             was parked, once
 *   nonblock  an O_NONBLOCK read() at the tail is EAGAIN and does not park;
 *             after a record arrives the same descriptor reads it
 *   poll      poll(POLLIN) at the tail waits for the record, then reports it
 *   epollet   an EPOLLET waiter at the tail is woken by the record, once
 *
 * The record is made by a forked "poker" that, after POKE_DELAY_MS, calls
 * inotify_init1: a deliberate, documented refusal (docs/posix-status.md)
 * that the kernel reports to the log as
 * "pid P called syscall 247 (inotify_init1), ...". Reading that exact line
 * back, with the poker's pid, is what proves the record read is the one the
 * poke caused and not an earlier one. The reader seeks to the tail first so
 * records already in the log are not mistaken for it. If inotify_init1 ever
 * starts working this fails loudly instead of passing.
 *
 * Each mode prints "READY" once the reader is set up and before the poker
 * runs, so a host can observe the parked state, then "kmsg-tail-<mode>-ok".
 */

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

#define DEFAULT_POKE_DELAY_MS 300
/* Long enough to ride out a loaded machine; a missing wake is a hang, and the
 * host's own timeout is the backstop. */
#define WAIT_MS 30000

static char line[8192];
static pid_t poker;

static int fail(const char *what)
{
	fprintf(stderr, "kmsg-tail failure: %s (errno=%d: %s)\n", what, errno, strerror(errno));
	return 1;
}

/* Open the device and move its cursor to the tail: only records logged from
 * now on will be read. */
static int open_at_tail(int flags)
{
	int fd = open("/dev/kmsg", flags);
	if (fd < 0) return -1;
	if (lseek(fd, 0, SEEK_END) < 0) {
		close(fd);
		return -1;
	}
	return fd;
}

/* Fork the poker. It makes the one record the reader is waiting for. */
static int start_poker(int delay_ms)
{
	poker = fork();
	if (poker < 0) return -1;
	if (poker == 0) {
		usleep((useconds_t)delay_ms * 1000);
		errno = 0;
		long r = syscall(SYS_inotify_init1, 0);
		/* A working inotify_init1 would log nothing: say so, loudly. */
		_exit(r == -1 && errno == ENOSYS ? 0 : 3);
	}
	return 0;
}

static int reap_poker(void)
{
	int status = 0;
	if (waitpid(poker, &status, 0) != poker) return fail("waitpid poker");
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
		fprintf(stderr, "kmsg-tail failure: the poker did not get ENOSYS from inotify_init1"
		        " (status %d); this test no longer exercises the log\n", status);
		return 1;
	}
	return 0;
}

/* The record read must be the poker's own report. */
static int line_is_pokers(ssize_t n)
{
	char want[96];
	if (n <= 0) return 0;
	line[n] = '\0';
	snprintf(want, sizeof want, "pid %d called syscall 247 (inotify_init1)", (int)poker);
	if (strstr(line, want) == NULL) {
		fprintf(stderr, "kmsg-tail failure: read %zd bytes, which are not the poker's record:"
		        " %s", n, line);
		return 0;
	}
	return 1;
}

static void ready(void)
{
	printf("READY\n");
	fflush(stdout);
}

static int mode_block(int delay_ms)
{
	int fd = open_at_tail(O_RDONLY);
	if (fd < 0) return fail("open /dev/kmsg");
	ready();
	if (start_poker(delay_ms) < 0) return fail("fork");
	/* Nothing is at the tail: this parks until the poker's record is logged. */
	ssize_t n = read(fd, line, sizeof line - 1);
	if (n < 0) return fail("blocking read at the tail");
	if (!line_is_pokers(n)) return 1;
	/* One record was consumed, so the tail is empty again. */
	if (fcntl(fd, F_SETFL, O_NONBLOCK) < 0) return fail("F_SETFL");
	errno = 0;
	if (read(fd, line, sizeof line - 1) != -1 || errno != EAGAIN) {
		return fail("a second read should be EAGAIN, the record was returned once");
	}
	if (reap_poker()) return 1;
	printf("kmsg-tail-block-ok\n");
	return 0;
}

static int mode_nonblock(int delay_ms)
{
	int fd = open_at_tail(O_RDONLY | O_NONBLOCK);
	if (fd < 0) return fail("open /dev/kmsg");
	/* Returns at once, rather than parking. */
	errno = 0;
	if (read(fd, line, sizeof line - 1) != -1 || errno != EAGAIN) {
		return fail("an O_NONBLOCK read at the tail should be EAGAIN");
	}
	ready();
	if (start_poker(delay_ms) < 0) return fail("fork");
	if (reap_poker()) return 1;
	/* The poker has exited, so its record is in the log. The EAGAIN above did
	 * not move the cursor, so this descriptor finds it. */
	ssize_t n = read(fd, line, sizeof line - 1);
	if (n < 0) return fail("read after the record was logged");
	if (!line_is_pokers(n)) return 1;
	errno = 0;
	if (read(fd, line, sizeof line - 1) != -1 || errno != EAGAIN) {
		return fail("the tail should be EAGAIN again");
	}
	printf("kmsg-tail-nonblock-ok\n");
	return 0;
}

static int mode_poll(int delay_ms)
{
	int fd = open_at_tail(O_RDONLY | O_NONBLOCK);
	struct pollfd p;
	if (fd < 0) return fail("open /dev/kmsg");
	p.fd = fd;
	p.events = POLLIN;
	p.revents = 0;
	if (poll(&p, 1, 0) != 0) return fail("poll at the tail should report nothing");
	ready();
	if (start_poker(delay_ms) < 0) return fail("fork");
	int r = poll(&p, 1, WAIT_MS);
	if (r != 1 || !(p.revents & POLLIN)) return fail("poll was not woken by the record");
	ssize_t n = read(fd, line, sizeof line - 1);
	if (n < 0) return fail("read after poll");
	if (!line_is_pokers(n)) return 1;
	p.revents = 0;
	if (poll(&p, 1, 0) != 0) return fail("poll should report nothing once the record is read");
	if (reap_poker()) return 1;
	printf("kmsg-tail-poll-ok\n");
	return 0;
}

static int mode_epollet(int delay_ms)
{
	int fd = open_at_tail(O_RDONLY | O_NONBLOCK);
	struct epoll_event ev, out;
	if (fd < 0) return fail("open /dev/kmsg");
	int ep = epoll_create1(0);
	if (ep < 0) return fail("epoll_create1");
	ev.events = EPOLLIN | EPOLLET;
	ev.data.u64 = 0x6b6d7367; /* "kmsg" */
	if (epoll_ctl(ep, EPOLL_CTL_ADD, fd, &ev) < 0) return fail("epoll_ctl ADD");
	/* Registering queues one edge. Drain it with nothing readable, so the only
	 * thing that can make the next wait return is a notification of a record
	 * logged after this point: an edge-triggered waiter reports nothing else. */
	if (epoll_wait(ep, &out, 1, 0) != 0) return fail("epoll_wait at the tail should report nothing");
	ready();
	if (start_poker(delay_ms) < 0) return fail("fork");
	int r = epoll_wait(ep, &out, 1, WAIT_MS);
	if (r != 1) return fail("the EPOLLET waiter was not woken by the record");
	if (!(out.events & EPOLLIN) || out.data.u64 != 0x6b6d7367) return fail("wrong event");
	ssize_t n = read(fd, line, sizeof line - 1);
	if (n < 0) return fail("read after the wake");
	if (!line_is_pokers(n)) return 1;
	/* The edge was consumed and the record read: nothing more to report. */
	if (epoll_wait(ep, &out, 1, 100) != 0) return fail("a consumed edge was reported again");
	if (reap_poker()) return 1;
	printf("kmsg-tail-epollet-ok\n");
	return 0;
}

int main(int argc, char **argv)
{
	int delay_ms = argc > 2 ? atoi(argv[2]) : DEFAULT_POKE_DELAY_MS;
	if (argc < 2) return fail("usage: kmsg_tail_test block|nonblock|poll|epollet [POKE_DELAY_MS]");
	if (strcmp(argv[1], "block") == 0) return mode_block(delay_ms);
	if (strcmp(argv[1], "nonblock") == 0) return mode_nonblock(delay_ms);
	if (strcmp(argv[1], "poll") == 0) return mode_poll(delay_ms);
	if (strcmp(argv[1], "epollet") == 0) return mode_epollet(delay_ms);
	return fail("unknown mode");
}
