/*
 * unlinkat() must reach the same filesystems unlink() and rmdir() reach.
 *
 * unlink(path), rmdir(path) and unlinkat(dirfd, name [, AT_REMOVEDIR]) are the
 * same two operations; unlinkat only names the target differently. A file
 * removable by unlink() must therefore be removable by unlinkat(), and a
 * directory removable by rmdir() must be removable by unlinkat(...,
 * AT_REMOVEDIR).
 *
 * Kandelo now serves /tmp from an in-kernel tmpfs. sys_unlink and sys_rmdir
 * dispatch to it (crate::tmpfs::claims_path) before falling through to the
 * host; sys_unlinkat does not, on either of its branches, so it reaches the
 * host for a path the host does not own. The upstream suite has exactly one
 * unlinkat case and it covers only the AT_REMOVEDIR branch, so the file
 * branch fails with nothing asking.
 *
 * This test asserts the equivalence directly, on both branches, and proves
 * the precondition in each case by first creating the object and confirming
 * the corresponding plain call CAN remove a sibling. That way a failure here
 * cannot be misread as "/tmp is not writable".
 */

#define SYSV_TEST_NAME "unlinkat-kernel-filesystems"

#include <sys/stat.h>
#include <fcntl.h>

#include "../sysv.h"

#define DIR_PATH "/tmp/unlinkat-kfs"

int main(void)
{
	if ( mkdir(DIR_PATH, 0700) < 0 )
		FAIL_ERRNO("mkdir " DIR_PATH);

	int dirfd = open(DIR_PATH, O_RDONLY | O_DIRECTORY);
	if ( dirfd < 0 )
		FAIL_ERRNO("open " DIR_PATH);

	/*
	 * Precondition: plain unlink() removes a file here. If this fails the
	 * problem is the directory, not unlinkat.
	 */
	int fd = open(DIR_PATH "/by-unlink", O_CREAT | O_WRONLY, 0600);
	if ( fd < 0 )
		FAIL_ERRNO("open by-unlink");
	if ( close(fd) < 0 )
		FAIL_ERRNO("close by-unlink");
	if ( unlink(DIR_PATH "/by-unlink") < 0 )
		FAIL_ERRNO("unlink by-unlink (precondition)");

	/* The same removal through unlinkat must work. */
	fd = open(DIR_PATH "/by-unlinkat", O_CREAT | O_WRONLY, 0600);
	if ( fd < 0 )
		FAIL_ERRNO("open by-unlinkat");
	if ( close(fd) < 0 )
		FAIL_ERRNO("close by-unlinkat");
	if ( unlinkat(dirfd, "by-unlinkat", 0) < 0 )
		FAILF("unlinkat could not remove a file that unlink() removes "
		      "from the same directory: %s -- unlinkat is not "
		      "reaching the filesystem that owns the path",
		      strerrno(errno));

	/* Precondition: plain rmdir() removes a subdirectory here. */
	if ( mkdir(DIR_PATH "/d-by-rmdir", 0700) < 0 )
		FAIL_ERRNO("mkdir d-by-rmdir");
	if ( rmdir(DIR_PATH "/d-by-rmdir") < 0 )
		FAIL_ERRNO("rmdir d-by-rmdir (precondition)");

	/* The same removal through unlinkat(AT_REMOVEDIR) must work. */
	if ( mkdir(DIR_PATH "/d-by-unlinkat", 0700) < 0 )
		FAIL_ERRNO("mkdir d-by-unlinkat");
	if ( unlinkat(dirfd, "d-by-unlinkat", AT_REMOVEDIR) < 0 )
		FAILF("unlinkat(AT_REMOVEDIR) could not remove a directory "
		      "that rmdir() removes from the same parent: %s",
		      strerrno(errno));

	if ( close(dirfd) < 0 )
		FAIL_ERRNO("close dirfd");
	if ( rmdir(DIR_PATH) < 0 )
		FAIL_ERRNO("rmdir " DIR_PATH);
	return 0;
}
