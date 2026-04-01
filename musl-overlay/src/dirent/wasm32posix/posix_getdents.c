#include <dirent.h>
#include <errno.h>
#include <stddef.h>
#include <unistd.h>

ssize_t posix_getdents(int fd, void *buf, size_t bufsize, int flags)
{
	if (flags != 0) {
		errno = EINVAL;
		return -1;
	}
	errno = ENOSYS;
	return -1;
}
