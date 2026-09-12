/*
 * setsockopt must reach the kernel's option logic, and its errors must be
 * the errors POSIX names.
 *
 * WHY THIS SHAPE: the defect this test was written for made EVERY setsockopt
 * return EINVAL, before the file descriptor, level or option name was ever
 * examined. The channel dispatch handed the width-checked kernel entry the
 * SIXTH channel argument word as a "process pointer width"; setsockopt takes
 * five arguments, so that word is always the 0 musl pads with, and the width
 * guard rejected it every time.
 *
 * A test that only sets a valid option and checks for 0 would have caught
 * that -- but so would almost anything, and nothing did, because the
 * conformance suite could not execute a guest at all until recently. What
 * makes this test durable is the opposite half: it pins the DISTINCT errno
 * each kind of misuse must produce.
 *
 * That matters because a layer that rejects setsockopt before dispatch can
 * only ever return one error. Requiring EBADF, ENOTSOCK and ENOPROTOOPT to
 * be told apart means any such short-circuit fails here no matter which
 * errno it happens to pick, whereas a single valid-option check only fails
 * if the short-circuit is not silently returning success.
 *
 * The read-back at the end is the other half: an implementation that
 * accepted the call and discarded the value would satisfy every errno
 * assertion above it.
 */

#define SYSV_TEST_NAME "setsockopt-reaches-the-kernel"

#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>

#include "../sysv.h"

/* A level and an option name no implementation assigns meaning to. */
#define UNKNOWN_LEVEL 12345
#define UNKNOWN_OPTNAME 9999

static void expect_set_errno(const char *what, int fd, int level, int optname,
                             int want)
{
	int one = 1;
	errno = 0;
	int rc = setsockopt(fd, level, optname, &one, sizeof one);
	if ( rc == 0 )
		FAILF("setsockopt(%s) succeeded; expected %s", what,
		      strerrno(want));
	if ( errno != want )
		FAILF("setsockopt(%s) failed with %s; expected %s", what,
		      strerrno(errno), strerrno(want));
}

int main(void)
{
	int udp = socket(AF_INET, SOCK_DGRAM, 0);
	if ( udp < 0 )
		FAIL_ERRNO("socket SOCK_DGRAM");
	int tcp = socket(AF_INET, SOCK_STREAM, 0);
	if ( tcp < 0 )
		FAIL_ERRNO("socket SOCK_STREAM");

	/* A supported option must be accepted. */
	int one = 1;
	if ( setsockopt(udp, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one) < 0 )
		FAILF("setsockopt(SO_REUSEADDR) failed with %s; the option is "
		      "supported, so this is the call not reaching the "
		      "kernel's option logic", strerrno(errno));

	/* ...and so must one at a different level, to pin both dispatch arms. */
	if ( setsockopt(tcp, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one) < 0 )
		FAILF("setsockopt(TCP_NODELAY) failed with %s",
		      strerrno(errno));

	/*
	 * Each misuse must be told apart. A layer short-circuiting setsockopt
	 * before dispatch collapses all three into one errno and fails here
	 * whichever one it chooses.
	 */
	expect_set_errno("bad fd", -1, SOL_SOCKET, SO_REUSEADDR, EBADF);
	expect_set_errno("non-socket fd", 1, SOL_SOCKET, SO_REUSEADDR,
	                 ENOTSOCK);
	expect_set_errno("unknown level", udp, UNKNOWN_LEVEL, 1, ENOPROTOOPT);
	expect_set_errno("unknown optname", udp, SOL_SOCKET, UNKNOWN_OPTNAME,
	                 ENOPROTOOPT);

	/*
	 * The value must actually have been stored. Without this, an
	 * implementation that returned 0 and dropped the option would pass
	 * everything above.
	 */
	int value = 0;
	socklen_t len = sizeof value;
	if ( getsockopt(udp, SOL_SOCKET, SO_REUSEADDR, &value, &len) < 0 )
		FAIL_ERRNO("getsockopt SO_REUSEADDR");
	if ( value == 0 )
		FAILF("getsockopt read back 0 for SO_REUSEADDR after "
		      "setsockopt reported success -- the option was accepted "
		      "and discarded");
	return 0;
}
