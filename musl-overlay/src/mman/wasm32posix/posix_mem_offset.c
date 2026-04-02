#include <errno.h>
#include <sys/mman.h>

int posix_mem_offset(const void *restrict addr, size_t len,
                     off_t *restrict off, size_t *restrict contig_len,
                     int *restrict fildes)
{
	errno = ENOSYS;
	return -1;
}
