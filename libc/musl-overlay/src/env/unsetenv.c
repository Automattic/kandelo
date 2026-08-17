/*
 * unsetenv.c — Wasm-POSIX override of musl's unsetenv.
 *
 * Removes the kernel Process value first, then performs an allocation-free
 * libc __environ commit so either both representations change or neither does.
 */

#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <bits/kandelo_limits.h>
#include "syscall.h"

static void dummy(char *old, char *new) {}
weak_alias(dummy, __env_rm_add);

int unsetenv(const char *name)
{
	size_t l = __strchrnul(name, '=') - name;
	if (!l || name[l]) {
		errno = EINVAL;
		return -1;
	}
	if (l > KANDELO_PROCESS_METADATA_ENTRY_MAX_BYTES) {
		errno = E2BIG;
		return -1;
	}

	/*
	 * The local removal below only compacts pointers and releases strings;
	 * it cannot fail. Ask the kernel first so an errno leaves environ exactly
	 * as the caller observed it on entry.
	 */
	long result = __syscall1(SYS_unsetenv, (long)name);
	if (result < 0) return __syscall_ret(result);

	if (__environ) {
		char **e = __environ, **eo = e;
		for (; *e; e++)
			if (!strncmp(name, *e, l) && l[*e] == '=')
				__env_rm_add(*e, 0);
			else if (eo != e)
				*eo++ = *e;
			else
				eo++;
		if (eo != e) *eo = 0;
	}
	return 0;
}
