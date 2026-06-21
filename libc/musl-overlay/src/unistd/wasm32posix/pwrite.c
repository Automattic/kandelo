#include <unistd.h>
#include "syscall.h"
#include "libc.h"

extern void __testcancel(void);
hidden long __syscall_cp_check(long);

ssize_t pwrite(int fd, const void *buf, size_t size, off_t ofs)
{
	/*
	 * Keep the positioned-write offset as one i64 channel argument. Using
	 * syscall_cp() here truncates offsets above 4 GiB on wasm32 because its
	 * public signature must stay long-sized for musl's variadic syscall ABI.
	 */
	__testcancel();
	long r = __syscall4(SYS_pwrite, fd, buf, size, ofs);
	return __syscall_ret(__syscall_cp_check(r));
}
