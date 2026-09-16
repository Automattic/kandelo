/*
 * ioctl must reach the kernel's request handlers, and its errors must be the
 * errors POSIX and Linux name.
 *
 * WHY THIS SHAPE: the defect this test was written for failed every ioctl
 * whose request appears in Kandelo's ioctl contract table -- SIOCGIFCONF,
 * SIOCGIFINDEX, FIONREAD -- with EINVAL, before the file descriptor was
 * examined. The channel dispatch handed the width-checked kernel entry the
 * SIXTH channel word as a "process pointer width"; ioctl takes three
 * arguments, so that word is always 0, and the guard rejected it.
 *
 * What made it hard to see is worth preserving in the test. Requests ABSENT
 * from the contract table skipped the guard entirely and answered ENOTTY,
 * correctly. So ioctl looked like it worked, and the failure looked specific
 * to network interfaces -- the whole net_if family fails through
 * SIOCGIFCONF, which is why it read as "Kandelo has no interfaces" rather
 * than "ioctl is broken".
 *
 * This test therefore asserts both halves together: a table request must
 * SUCCEED, a non-table request must fail ENOTTY, and a bad descriptor must
 * fail EBADF. Requiring those three to differ fails any layer that rejects
 * ioctl before dispatch, whichever single errno it happens to pick.
 */

#define SYSV_TEST_NAME "ioctl-reaches-the-kernel"

#include <sys/ioctl.h>
#include <sys/socket.h>
#include <net/if.h>

#include <string.h>

#include "../sysv.h"

/* A request no implementation assigns meaning to. */
#define UNKNOWN_REQUEST 0x7777

int main(void)
{
	int fd = socket(AF_INET, SOCK_DGRAM, 0);
	if ( fd < 0 )
		FAIL_ERRNO("socket");

	/*
	 * A request in the contract table must be dispatched. SIOCGIFCONF with
	 * a zero-length buffer is the sizing query every interface enumerator
	 * starts with, including this libc's if_nameindex().
	 */
	struct ifconf ifc;
	memset(&ifc, 0, sizeof ifc);
	if ( ioctl(fd, SIOCGIFCONF, &ifc) < 0 )
		FAILF("ioctl(SIOCGIFCONF) failed with %s; the request is "
		      "supported, so this is the call not reaching the "
		      "kernel's ioctl handlers", strerrno(errno));

	/* FIONREAD is a different handler, to pin more than one table entry. */
	int pending = -1;
	if ( ioctl(fd, FIONREAD, &pending) < 0 )
		FAILF("ioctl(FIONREAD) failed with %s", strerrno(errno));
	if ( pending < 0 )
		FAILF("ioctl(FIONREAD) reported success but left the count at "
		      "%d", pending);

	/*
	 * A request that is NOT in the table must still be dispatched, and
	 * must report ENOTTY rather than sharing an errno with the cases
	 * above. This is the half that distinguishes "dispatch works" from
	 * "everything is rejected the same way".
	 */
	int scratch = 0;
	errno = 0;
	if ( ioctl(fd, UNKNOWN_REQUEST, &scratch) == 0 )
		FAILF("ioctl with an unknown request succeeded");
	if ( errno != ENOTTY )
		FAILF("ioctl with an unknown request failed with %s; expected "
		      "ENOTTY", strerrno(errno));

	/* A bad descriptor must be EBADF, not whatever a pre-dispatch
	 * rejection would return. */
	errno = 0;
	memset(&ifc, 0, sizeof ifc);
	if ( ioctl(-1, SIOCGIFCONF, &ifc) == 0 )
		FAILF("ioctl on a closed descriptor succeeded");
	if ( errno != EBADF )
		FAILF("ioctl on a bad descriptor failed with %s; expected "
		      "EBADF -- an ioctl rejected before the descriptor is "
		      "checked cannot report this", strerrno(errno));

	if ( close(fd) < 0 )
		FAIL_ERRNO("close");
	return 0;
}
