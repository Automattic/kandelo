/*
 * Opt-in mprotect(): sysroot/lib/libkandelo-mprotect.a
 *
 * WebAssembly linear memory has no page protection: every byte below the
 * memory's size is readable and writable, and data memory is never
 * executable (code lives outside it). Kandelo therefore cannot make a page
 * read-only, inaccessible, or newly executable, and libc.a defines no public
 * mprotect(): a program that calls it fails to link (the SDK names this
 * library in the link error). musl's own callers use the internal
 * __mprotect().
 *
 * Software that needs mprotect() only to make memory accessible -- to commit
 * pages of a PROT_NONE reservation, or to make a mapping writable -- can opt
 * in:
 *
 *     LIBS="-lkandelo-mprotect"
 *
 * This mprotect() accepts a request that keeps read and write access
 * (PROT_READ | PROT_WRITE, with or without PROT_EXEC: the execute bit grants
 * or removes nothing for data memory) and passes it to the kernel, which
 * validates the range (ENOMEM for pages that are not mapped) and keeps its
 * side effects, such as making a shared file mapping eligible for writeback.
 * A request that would remove read or write access -- PROT_NONE, read-only,
 * a write barrier, a guard page -- fails with ENOTSUP, POSIX's answer when
 * "the implementation does not support the combination of accesses
 * requested", instead of reporting a protection that would not be enforced.
 * Unknown protection bits are EINVAL.
 *
 * This library is not linked by default and must stay that way: linking it
 * implicitly would let configure checks and portable code believe page
 * protection exists.
 */

#include <errno.h>
#include <stddef.h>
#include <sys/mman.h>

/* libc.a's internal mprotect: page rounding and the SYS_mprotect call. */
int __mprotect(void *addr, size_t len, int prot);

int mprotect(void *addr, size_t len, int prot)
{
	if (prot & ~(PROT_READ | PROT_WRITE | PROT_EXEC)) {
		errno = EINVAL;
		return -1;
	}
	if ((prot & (PROT_READ | PROT_WRITE)) != (PROT_READ | PROT_WRITE)) {
		errno = ENOTSUP;
		return -1;
	}
	return __mprotect(addr, len, prot);
}
