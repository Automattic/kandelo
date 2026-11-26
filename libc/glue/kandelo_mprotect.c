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
 * This mprotect() is the truthful policy: it accepts a request that keeps
 * read and write access (PROT_READ | PROT_WRITE, with or without PROT_EXEC)
 * and passes it to the kernel, which validates the range (ENOMEM for pages
 * that are not mapped) and keeps its side effects, such as making a shared
 * file mapping eligible for writeback. A request that would remove read or
 * write access -- PROT_NONE, read-only, a write barrier, a guard page --
 * fails with ENOTSUP instead of reporting a protection that would not be
 * enforced. Unknown protection bits are EINVAL.
 *
 * A package that must have such a request reported as successful declares
 * the mprotect fiction (sdk/fictions/mprotect.toml); the SDK driver then
 * links a generated mprotect() with the declared policy ahead of this one.
 * Both call __kandelo_mprotect_with_policy() (kandelo_mprotect_policy.c).
 *
 * This library is not linked by default and must stay that way: linking it
 * implicitly would let configure checks and portable code believe page
 * protection exists.
 */

#include <stddef.h>

#include "kandelo_mprotect_policy.h"

static const struct __kandelo_mprotect_policy truthful = {
	.version = KANDELO_MPROTECT_POLICY_VERSION,
	.prot_none = KANDELO_MPROTECT_ENOTSUP,
	.read_only = KANDELO_MPROTECT_ENOTSUP,
};

int mprotect(void *addr, size_t len, int prot)
{
	return __kandelo_mprotect_with_policy(addr, len, prot, &truthful);
}
