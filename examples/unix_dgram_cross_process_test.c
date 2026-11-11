/*
 * unix_dgram_cross_process_test.c — prove syslog(3)'s sequence crosses a
 * process boundary.
 *
 * Making /dev/log bindable is not what makes syslog(3) work. Kandelo refused
 * every AF_UNIX datagram whose peer lived in another process, so a daemon
 * could bind /dev/log and nothing could ever send to it. The routing repair
 * is unit-tested in Rust (crates/runtime-core/src/syscalls.rs); what can only
 * be shown from a guest is that musl's real socket(), connect() and send() —
 * through the channel glue, host argument staging and kernel dispatch —
 * deliver a datagram from one process to a socket another process bound.
 *
 * That sequence is exactly what syslog(3) performs, which is why this
 * program performs it against /dev/log itself rather than a stand-in path.
 *
 * The load-bearing case is the last one. A recorded association outlives its
 * peer's close(), and a freed socket slot is handed to the next socket that
 * process allocates — so a stale send used to pass every validity check and
 * queue a log line into an unrelated socket that happened to land in the same
 * slot. Delivery is gated on endpoint identity now, and a guest is where the
 * close-and-reuse ordering is real rather than arranged.
 */

#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

/* The path musl's syslog(3) connects to. */
#define LOG_PATH "/dev/log"

/* An ordinary, unprivileged identity for the sender half. */
#define UNPRIVILEGED_UID 1000
#define UNPRIVILEGED_GID 1000

#define LARGE_WRITE_SIZE 65537
static char large_payload[LARGE_WRITE_SIZE];
static int failures;

static void fail(const char *who, const char *message)
{
	fprintf(stderr, "%s failure: %s (errno=%d: %s)\n",
	        who, message, errno, strerror(errno));
	failures++;
}

static int dgram_socket(void)
{
	return socket(AF_UNIX, SOCK_DGRAM, 0);
}

static int dgram_connect(int fd, const char *path)
{
	struct sockaddr_un addr;

	memset(&addr, 0, sizeof addr);
	addr.sun_family = AF_UNIX;
	strncpy(addr.sun_path, path, sizeof addr.sun_path - 1);
	return connect(fd, (struct sockaddr *)&addr, sizeof addr);
}

/* Expect a connect() to fail with a specific errno.
 *
 * The two refusals are reached at different layers, which is why the expected
 * errno is a parameter rather than one constant. A pathname that does not
 * resolve fails in the filesystem with ENOENT before the socket layer is
 * consulted; a pathname that resolves but names no live datagram endpoint is
 * ECONNREFUSED. The kernel's routing unit tests call the routing entry point
 * directly with an address, so they only ever see the second one. */
static void expect_connect_errno(const char *path, int expected,
                                 const char *what)
{
	int fd = dgram_socket();

	if (fd < 0) {
		fail("child", "socket() for a refusal probe");
		return;
	}
	errno = 0;
	if (dgram_connect(fd, path) != -1 || errno != expected) {
		fail("child", what);
	}
	close(fd);
}

/* The sender: a process that did not bind /dev/log.
 *
 * `drop_privileges` models the real relationship between a syslog daemon and
 * its clients. Binding /dev/log needs write permission on /dev, so only root
 * can run the daemon; the node itself is mode 0666 so that any program
 * linking musl can connect and log. A sender that has dropped to an ordinary
 * uid must still be routed. */
static int run_child(int notify_fd, int wait_fd, int drop_privileges)
{
	char slot;
	int log_fd;

	if (drop_privileges) {
		/* Group first: setuid() would strip the authority to call
		 * setgid() afterwards. */
		if (setgid(UNPRIVILEGED_GID) != 0) {
			fail("child", "setgid()");
			return 1;
		}
		if (setuid(UNPRIVILEGED_UID) != 0) {
			fail("child", "setuid()");
			return 1;
		}
		if (geteuid() != UNPRIVILEGED_UID) {
			fail("child", "privileges were not dropped");
			return 1;
		}
	}

	log_fd = dgram_socket();
	if (log_fd < 0) {
		fail("child", "socket(AF_UNIX, SOCK_DGRAM)");
		return 1;
	}

	/* syslog(3)'s sequence: connect to a path another process bound... */
	if (dgram_connect(log_fd, LOG_PATH) != 0) {
		fail("child", "connect(\"" LOG_PATH "\") across processes");
		return 1;
	}
	/* ...then send, with no destination address of its own. */
	if (send(log_fd, "msg1", 4, 0) != 4) {
		fail("child", "send() across processes");
		return 1;
	}

	/* Cross the channel-sized boundary through write(), retaining one
	 * datagram even though the receiver belongs to another process. */
	memset(large_payload, 'L', sizeof large_payload);
	if (write(log_fd, large_payload, sizeof large_payload) != sizeof large_payload) {
		fail("child", "large write() across processes");
		return 1;
	}

	/* A peer that is absent or not a datagram socket at all is still
	 * refused; cross-process routing widened what can be reached, not what
	 * counts as reachable. /dev/null exists and is a character device, so it
	 * resolves and is then refused by the socket layer. */
	expect_connect_errno("/dev/kandelo-no-such-log", ENOENT,
	                     "connect() to a missing path should be ENOENT");
	expect_connect_errno("/dev/null", ECONNREFUSED,
	                     "connect() to a non-socket should be ECONNREFUSED");

	/* Tell the parent the datagram is sent, and wait for it to close the
	 * bound socket and allocate another one into the freed slot. */
	if (write(notify_fd, "1", 1) != 1) {
		fail("child", "notifying the parent");
		return 1;
	}
	if (read(wait_fd, &slot, 1) != 1) {
		fail("child", "waiting for the parent to reuse the slot");
		return 1;
	}

	/* The recorded association now names an endpoint that no longer exists.
	 * The socket occupying its old slot is not that endpoint, so this send
	 * must be refused rather than delivered to a stranger. */
	errno = 0;
	if (send(log_fd, "msg2", 4, 0) != -1 || errno != ECONNREFUSED) {
		fail("child", "send() to a closed peer should be ECONNREFUSED");
	}

	close(log_fd);
	return failures != 0;
}

int main(int argc, char **argv)
{
	/* "unpriv" makes the sender drop privileges before it connects; the
	 * default keeps both halves privileged. The parent always stays root,
	 * because binding /dev/log requires it. */
	int drop_privileges = argc > 1 && strcmp(argv[1], "unpriv") == 0;
	int to_parent[2];
	int to_child[2];
	char payload[64];
	char slot;
	ssize_t received;
	int log_fd;
	int reuse_fd;
	int status;
	pid_t child;

	if (pipe(to_parent) != 0 || pipe(to_child) != 0) {
		fail("parent", "pipe()");
		return 1;
	}

	/* The daemon's half: bind the well-known path before forking, so the
	 * sender is a process that never owned it. */
	log_fd = dgram_socket();
	if (log_fd < 0) {
		fail("parent", "socket(AF_UNIX, SOCK_DGRAM)");
		return 1;
	}
	{
		struct sockaddr_un addr;

		memset(&addr, 0, sizeof addr);
		addr.sun_family = AF_UNIX;
		strncpy(addr.sun_path, LOG_PATH, sizeof addr.sun_path - 1);
		if (bind(log_fd, (struct sockaddr *)&addr, sizeof addr) != 0) {
			fail("parent", "bind(\"" LOG_PATH "\")");
			return 1;
		}
	}

	child = fork();
	if (child < 0) {
		fail("parent", "fork()");
		return 1;
	}
	if (child == 0) {
		close(to_parent[0]);
		close(to_child[1]);
		close(log_fd);
		return run_child(to_parent[1], to_child[0], drop_privileges);
	}

	close(to_parent[1]);
	close(to_child[0]);

	/* Wait until the child has sent, so an empty queue means lost rather
	 * than early. */
	if (read(to_parent[0], &slot, 1) != 1) {
		fail("parent", "waiting for the child's datagram");
		return 1;
	}

	memset(payload, 0, sizeof payload);
	received = recv(log_fd, payload, sizeof payload, 0);
	if (received != 4 || memcmp(payload, "msg1", 4) != 0) {
		fprintf(stderr,
		        "parent failure: recv() returned %zd (%.*s), expected 4"
		        " (msg1) (errno=%d: %s)\n",
		        received, received > 0 ? (int)received : 0, payload,
		        errno, strerror(errno));
		failures++;
	}

	memset(large_payload, 0, sizeof large_payload);
	received = recv(log_fd, large_payload, sizeof large_payload, 0);
	if (received != sizeof large_payload) {
		fail("parent", "large write() did not arrive as one datagram");
	} else {
		for (size_t i = 0; i < sizeof large_payload; i++) {
			if (large_payload[i] != 'L') {
				fail("parent", "large write() bytes changed");
				break;
			}
		}
	}

	/* Retire the endpoint the child is still pointing at, then allocate
	 * another datagram socket. Slot allocation returns the lowest free
	 * index, so this one lands where the bound socket was. */
	close(log_fd);
	reuse_fd = dgram_socket();
	if (reuse_fd < 0) {
		fail("parent", "socket() for the reused slot");
		return 1;
	}
	if (write(to_child[1], "2", 1) != 1) {
		fail("parent", "releasing the child");
		return 1;
	}

	if (waitpid(child, &status, 0) != child) {
		fail("parent", "waitpid()");
		return 1;
	}
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
		fprintf(stderr, "parent failure: child exited with status %d\n",
		        status);
		failures++;
	}

	/* Nothing may have arrived here. The child's stale association named an
	 * endpoint, not a slot, so its refused send must have queued nowhere. */
	errno = 0;
	received = recv(reuse_fd, payload, sizeof payload, MSG_DONTWAIT);
	if (received != -1 || (errno != EAGAIN && errno != EWOULDBLOCK)) {
		fprintf(stderr,
		        "parent failure: the reused slot received %zd byte(s)"
		        " from a refused send (errno=%d: %s)\n",
		        received, errno, strerror(errno));
		failures++;
	}
	close(reuse_fd);

	if (failures != 0) {
		fprintf(stderr, "unix-dgram-cross-process-test: %d failure(s)\n",
		        failures);
		return 1;
	}
	printf("unix-dgram-cross-process-ok\n");
	return 0;
}
