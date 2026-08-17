/*
 * setenv.c — Wasm-POSIX override of musl's setenv / __env_rm_add.
 *
 * Keeps the original musl logic for __environ management, then also
 * calls SYS_setenv to sync the kernel's proc.environ store. This ensures
 * env vars survive fork/exec (where __environ is rebuilt from proc.environ).
 */

#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include "syscall.h"

void __env_rm_add(char *old, char *new)
{
	static char **env_alloced;
	static size_t env_alloced_n;
	for (size_t i=0; i < env_alloced_n; i++)
		if (env_alloced[i] == old) {
			env_alloced[i] = new;
			free(old);
			return;
		} else if (!env_alloced[i] && new) {
			env_alloced[i] = new;
			new = 0;
		}
	if (!new) return;
	char **t = realloc(env_alloced, sizeof *t * (env_alloced_n+1));
	if (!t) return;
	(env_alloced = t)[env_alloced_n++] = new;
}

int setenv(const char *var, const char *value, int overwrite)
{
	char *s;
	size_t l1, l2;

	if (!var || !(l1 = __strchrnul(var, '=') - var) || var[l1]) {
		errno = EINVAL;
		return -1;
	}
	if (!overwrite && getenv(var)) return 0;

	l2 = strlen(value);
	s = malloc(l1+l2+2);
	if (!s) return -1;
	memcpy(s, var, l1);
	s[l1] = '=';
	memcpy(s+l1+1, value, l2+1);
	int r = __putenv(s, l1, s);
	if (r == 0) {
		/* Sync with kernel's proc.environ */
		__syscall3(SYS_setenv, (long)var, (long)value, (long)overwrite);
	}
	return r;
}
