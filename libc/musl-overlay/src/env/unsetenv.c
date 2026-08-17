/*
 * unsetenv.c — Wasm-POSIX override of musl's unsetenv.
 *
 * Keeps original musl logic for __environ compaction, then calls
 * SYS_unsetenv to remove the variable from the kernel's proc.environ.
 */

#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
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
	/* Sync with kernel's proc.environ */
	__syscall1(SYS_unsetenv, (long)name);
	return 0;
}
