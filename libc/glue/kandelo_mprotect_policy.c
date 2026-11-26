/*
 * The one mprotect implementation behind libkandelo-mprotect.a.
 *
 * WebAssembly linear memory has no page protection: every byte below the
 * memory's size is readable and writable, and data memory is never
 * executable (code lives outside it). A request that keeps read and write
 * access (with or without PROT_EXEC, which grants or removes nothing for data
 * memory) is therefore exactly what Kandelo does, and goes to the kernel,
 * which validates the range and keeps its side effects.
 *
 * A request that would remove read or write access cannot be honoured. What
 * happens to it is the policy's choice, per class:
 *
 *   ENOTSUP            POSIX's answer when "the implementation does not
 *                      support the combination of accesses requested". The
 *                      truthful default, and the only behaviour without a
 *                      declared fiction.
 *   accept-unenforced  The declared mprotect fiction (sdk/fictions/
 *                      mprotect.toml): the request goes to the kernel, which
 *                      validates it (EINVAL, ENOMEM) and logs the first such
 *                      request of the process to /dev/kmsg, and success is
 *                      reported although access is unchanged. A per-class
 *                      maximum length keeps the fiction to the requests it
 *                      was declared for.
 *
 * Unknown protection bits are EINVAL in every case.
 */

#define _GNU_SOURCE
#include <errno.h>
#include <limits.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/mman.h>

#include "kandelo_mprotect_policy.h"

/* libc.a's internal mprotect: page rounding and the SYS_mprotect call. */
int __mprotect(void *addr, size_t len, int prot);

/* The length __mprotect hands the kernel: the request rounded out to whole
 * pages. Computed in 64 bits so a request whose end wraps is too long for
 * any maximum rather than short. */
static uint64_t rounded_length(void *addr, size_t len)
{
	uint64_t start = (uintptr_t)addr & -(uint64_t)PAGESIZE;
	uint64_t end = ((uint64_t)(uintptr_t)addr + len + PAGESIZE - 1)
		& -(uint64_t)PAGESIZE;
	return end - start;
}

int __kandelo_mprotect_with_policy(void *addr, size_t len, int prot,
	const struct __kandelo_mprotect_policy *policy)
{
	if (prot & ~(PROT_READ | PROT_WRITE | PROT_EXEC)) {
		errno = EINVAL;
		return -1;
	}
	if ((prot & (PROT_READ | PROT_WRITE)) == (PROT_READ | PROT_WRITE))
		return __mprotect(addr, len, prot);

	if (!policy || policy->version != KANDELO_MPROTECT_POLICY_VERSION) {
		errno = ENOTSUP;
		return -1;
	}
	unsigned action;
	uint64_t max;
	if (!(prot & PROT_READ)) {
		action = policy->prot_none;
		max = policy->prot_none_max;
	} else {
		action = policy->read_only;
		max = policy->read_only_max;
	}
	if (action != KANDELO_MPROTECT_ACCEPT_UNENFORCED
	    || (max != 0 && rounded_length(addr, len) > max)) {
		errno = ENOTSUP;
		return -1;
	}
	return __mprotect(addr, len, prot);
}
