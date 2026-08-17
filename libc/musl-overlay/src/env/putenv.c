/*
 * putenv.c — Wasm-POSIX override of musl's putenv / __putenv.
 *
 * Keeps the original musl logic for __environ management, then calls
 * SYS_setenv or SYS_unsetenv to sync the kernel's proc.environ store.
 */

#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "syscall.h"

static void dummy(char *old, char *new) {}
weak_alias(dummy, __env_rm_add);

int __putenv(char *s, size_t l, char *r)
{
	size_t i=0;
	if (__environ) {
		for (char **e = __environ; *e; e++, i++)
			if (!strncmp(s, *e, l+1)) {
				char *tmp = *e;
				*e = s;
				__env_rm_add(tmp, r);
				return 0;
			}
	}
	static char **oldenv;
	char **newenv;
	if (__environ == oldenv) {
		newenv = realloc(oldenv, sizeof *newenv * (i+2));
		if (!newenv) goto oom;
	} else {
		newenv = malloc(sizeof *newenv * (i+2));
		if (!newenv) goto oom;
		if (i) memcpy(newenv, __environ, sizeof *newenv * i);
		free(oldenv);
	}
	newenv[i] = s;
	newenv[i+1] = 0;
	__environ = oldenv = newenv;
	if (r) __env_rm_add(0, r);
	return 0;
oom:
	free(r);
	return -1;
}

int putenv(char *s)
{
	size_t l = __strchrnul(s, '=') - s;
	if (!l || !s[l]) return unsetenv(s);
	int r = __putenv(s, l, 0);
	if (r == 0) {
		/*
		 * Sync with kernel. Extract name and value from "KEY=VALUE".
		 * We pass the full name (length l) and value (after '=')
		 * through the SYS_setenv syscall which expects (name, value, overwrite).
		 */
		char name_buf[256];
		if (l < sizeof(name_buf)) {
			memcpy(name_buf, s, l);
			name_buf[l] = '\0';
			__syscall3(SYS_setenv, (long)name_buf, (long)(s + l + 1), 1);
		}
	}
	return r;
}
