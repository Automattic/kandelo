#include <errno.h>

int posix_typed_mem_open(const char *name, int oflag, int tflag)
{
	errno = ENOSYS;
	return -1;
}
