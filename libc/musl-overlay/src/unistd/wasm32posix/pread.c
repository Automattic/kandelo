#include <unistd.h>
#include "syscall.h"
#include "libc.h"

extern void __testcancel(void);
hidden long __syscall_cp_check(long);

ssize_t pread(int fd, void *buf, size_t size, off_t ofs)
{
	/*
	 * wasm32posix keeps channel arguments in i64 slots, so positioned I/O
	 * offsets must reach SYS_pread as one full-width argument. The generic
	 * musl pread.c uses syscall_cp(), whose ABI is constrained to long-sized
	 * args for variadic syscall() compatibility on wasm32.
	 */
	__testcancel();
	long r = __syscall4(SYS_pread, fd, buf, size, ofs);
	return __syscall_ret(__syscall_cp_check(r));
}
