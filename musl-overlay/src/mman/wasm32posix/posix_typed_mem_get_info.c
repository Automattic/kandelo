#include <errno.h>
#include <sys/mman.h>

int posix_typed_mem_get_info(int fildes, struct posix_typed_mem_info *info)
{
	errno = ENOSYS;
	return -1;
}
