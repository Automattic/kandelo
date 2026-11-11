/*
 * syslog_client_test.c — musl's syslog(3) against a daemon on /dev/log.
 *
 * examples/unix_dgram_cross_process_test.c proves the datagram routing with
 * sockets this program builds itself. That is not quite the real path: musl's
 * syslog(3) connects with an abbreviated address, a `struct { short family;
 * char path[9]; }` of 11 bytes rather than a full sockaddr_un, so a kernel
 * that insisted on the full structure would refuse the one call every ported
 * program actually makes while a hand-built socket still worked.
 *
 * So this program calls openlog()/syslog() and checks what arrives, byte for
 * byte, on a socket bound to /dev/log by another process. That covers the
 * whole client half of the facility: musl's address, its RFC-3164-shaped
 * framing, the tag, and the priority a receiver has to parse to decide where
 * a message belongs.
 *
 * It also pins the optionality contract. POSIX gives syslog(3) no way to
 * report failure -- it returns void -- and musl ignores the result of its
 * connect(), so on a machine with no daemon the message is dropped and the
 * program is told nothing. That is the specified behaviour, and `silent` mode
 * proves Kandelo does it rather than failing the caller.
 */

#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <syslog.h>
#include <unistd.h>

#define LOG_PATH "/dev/log"
#define TAG "kandelo-test"
#define MESSAGE "hello"

/* LOG_USER (1) * 8 + LOG_INFO (6). A receiver reads the facility and level
 * back out of this one number, so it is the field that decides routing. */
#define EXPECTED_PRI (1 * 8 + 6)

static int failures;

static void fail(const char *who, const char *message)
{
	fprintf(stderr, "%s failure: %s (errno=%d: %s)\n",
	        who, message, errno, strerror(errno));
	failures++;
}

/* The client half: exactly what a ported program does. */
static void log_one_message(void)
{
	openlog(TAG, 0, LOG_USER);
	syslog(LOG_INFO, "%s", MESSAGE);
	closelog();
}

int main(int argc, char **argv)
{
	int silent = argc > 1 && strcmp(argv[1], "silent") == 0;
	char payload[512];
	struct sockaddr_un addr;
	ssize_t received;
	int log_fd;
	int status;
	pid_t child;

	if (silent) {
		/* No daemon has bound /dev/log. syslog(3) must return normally;
		 * the message goes nowhere and the caller is not told, because
		 * the interface has no way to tell it. */
		log_one_message();
		/* Reaching here at all is the assertion: a refused connect or a
		 * failed send must not raise a signal or abort the process. */
		printf("syslog-client-silent-ok\n");
		return 0;
	}

	log_fd = socket(AF_UNIX, SOCK_DGRAM, 0);
	if (log_fd < 0) {
		fail("daemon", "socket(AF_UNIX, SOCK_DGRAM)");
		return 1;
	}
	memset(&addr, 0, sizeof addr);
	addr.sun_family = AF_UNIX;
	strncpy(addr.sun_path, LOG_PATH, sizeof addr.sun_path - 1);
	if (bind(log_fd, (struct sockaddr *)&addr, sizeof addr) != 0) {
		fail("daemon", "bind(\"" LOG_PATH "\")");
		return 1;
	}

	child = fork();
	if (child < 0) {
		fail("daemon", "fork()");
		return 1;
	}
	if (child == 0) {
		close(log_fd);
		log_one_message();
		return 0;
	}

	memset(payload, 0, sizeof payload);
	received = recv(log_fd, payload, sizeof payload - 1, 0);
	if (received <= 0) {
		fail("daemon", "recv() of the client's syslog message");
	} else {
		/* musl frames the message as
		 *   <pri>MMM DD HH:MM:SS tag: text\n
		 * Check the parts a daemon routes on, not the timestamp, which is
		 * the clock's business. */
		int pri = -1;
		char *rest;

		if (sscanf(payload, "<%d>", &pri) != 1 || pri != EXPECTED_PRI) {
			fprintf(stderr,
			        "daemon failure: priority was %d, expected %d, in %s",
			        pri, EXPECTED_PRI, payload);
			failures++;
		}
		rest = strstr(payload, TAG ": " MESSAGE);
		if (rest == NULL) {
			fprintf(stderr,
			        "daemon failure: tag and message missing from %s",
			        payload);
			failures++;
		}
		if (payload[received - 1] != '\n') {
			fail("daemon", "message was not newline terminated");
		}
	}

	if (waitpid(child, &status, 0) != child) {
		fail("daemon", "waitpid()");
	} else if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
		fprintf(stderr, "daemon failure: client exited with status %d\n",
		        status);
		failures++;
	}
	close(log_fd);

	if (failures != 0) {
		fprintf(stderr, "syslog-client-test: %d failure(s)\n", failures);
		return 1;
	}
	printf("syslog-client-ok\n");
	return 0;
}
