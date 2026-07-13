#include <unistd.h>
#include "aio_impl.h"
#include "syscall.h"

/*
 * Upstream musl converts close(2)'s EINTR result into success for Linux,
 * where the descriptor has already been consumed even when close reports an
 * interruption. Kandelo's blocking /dev/dsp final close preflights its drain
 * before mutating the descriptor table: EINTR therefore means the fd is still
 * valid and the caller can retry or reset it. Preserve that truthful result.
 */
static int dummy(int fd)
{
	return fd;
}

weak_alias(dummy, __aio_close);

int close(int fd)
{
	fd = __aio_close(fd);
	return __syscall_ret(__syscall_cp(SYS_close, fd));
}
