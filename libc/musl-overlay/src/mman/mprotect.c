#include <sys/mman.h>
#include "libc.h"
#include "syscall.h"

/* Kandelo: libc.a defines only the internal __mprotect, which musl's own
 * callers use to make PROT_NONE reservations accessible (pthread_create's
 * stack, mallocng's meta areas). There is no public mprotect: Wasm cannot
 * enforce page protection, so a program that calls mprotect() fails to link
 * unless it opts in to -lkandelo-mprotect, whose mprotect() accepts requests
 * that keep read and write access and refuses the rest with ENOTSUP
 * (libc/glue/kandelo_mprotect.c, docs/posix-status.md). Upstream musl
 * defines mprotect as a weak alias of this function. */
int __mprotect(void *addr, size_t len, int prot)
{
	size_t start, end;
	start = (size_t)addr & -PAGE_SIZE;
	end = (size_t)((char *)addr + len + PAGE_SIZE-1) & -PAGE_SIZE;
	return syscall(SYS_mprotect, start, end-start, prot);
}
