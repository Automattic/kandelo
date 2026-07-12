#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

_Static_assert(sizeof(struct timeval) == 16,
	"socket timeout marshalling requires a 16-byte timeval");

#if __SIZEOF_LONG__ == 4
_Static_assert(SO_RCVTIMEO == 66, "wasm32 must use the time64 receive option");
_Static_assert(SO_SNDTIMEO == 67, "wasm32 must use the time64 send option");
#elif __SIZEOF_LONG__ == 8
_Static_assert(SO_RCVTIMEO == 20, "wasm64 must use the long64 receive option");
_Static_assert(SO_SNDTIMEO == 21, "wasm64 must use the long64 send option");
#else
#error "unsupported long width"
#endif

static int check(int condition, const char *message)
{
	if (condition) return 0;
	fprintf(stderr, "socket timeout option failure: %s (errno=%d)\n",
		message, errno);
	return 1;
}

static int set_and_check_timeout(int fd, int option,
	const struct timeval *expected, const char *name)
{
	if (setsockopt(fd, SOL_SOCKET, option, expected, sizeof(*expected)) < 0) {
		fprintf(stderr, "socket timeout option failure: set %s: %s\n",
			name, strerror(errno));
		return 1;
	}

	struct timeval actual = { .tv_sec = -1, .tv_usec = -1 };
	socklen_t length = sizeof(actual);
	if (getsockopt(fd, SOL_SOCKET, option, &actual, &length) < 0) {
		fprintf(stderr, "socket timeout option failure: get %s: %s\n",
			name, strerror(errno));
		return 1;
	}

	int failed = 0;
	failed |= check(length == sizeof(actual), "get returns struct timeval size");
	failed |= check(actual.tv_sec == expected->tv_sec, name);
	failed |= check(actual.tv_usec == expected->tv_usec, name);
	return failed;
}

int main(void)
{
	int fd = socket(AF_INET, SOCK_STREAM, 0);
	if (fd < 0) {
		perror("socket timeout option failure: socket");
		return 1;
	}

	const struct timeval receive = { .tv_sec = 1, .tv_usec = 250000 };
	const struct timeval send = { .tv_sec = 2, .tv_usec = 500000 };
	int failed = 0;
	failed |= set_and_check_timeout(fd, SO_RCVTIMEO, &receive, "receive timeout");
	failed |= set_and_check_timeout(fd, SO_SNDTIMEO, &send, "send timeout");
	failed |= check(close(fd) == 0, "close socket");

	if (failed) return 1;
	puts("SOCKET_TIMEOUT_OPTIONS_PASS");
	return 0;
}
