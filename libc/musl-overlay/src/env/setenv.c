/*
 * setenv.c — Wasm-POSIX override of musl's setenv / __env_rm_add.
 *
 * Keeps libc's __environ and the kernel Process environment coherent across
 * successful calls and failures. Environment variables therefore survive
 * fork/exec, where __environ is rebuilt from the kernel-owned representation.
 */

#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <bits/kandelo_limits.h>
#include "syscall.h"

static char **env_alloced;
static size_t env_alloced_n;

hidden int __putenv_kernel_sync(
	char *, size_t, char *, const char *, const char *);

/*
 * Reserve any ownership-table slot that __env_rm_add will need later.
 *
 * WHY: the Wasm-POSIX environment has two authoritative representations:
 * libc's environ and the kernel Process environment. Callers reserve every
 * fallible libc allocation before asking the kernel to mutate its copy, so
 * the local commit after kernel success must not fail.
 */
hidden int __env_rm_prepare(char *old, char *new)
{
	if (!new) return 0;
	for (size_t i=0; i < env_alloced_n; i++)
		if (env_alloced[i] == old || !env_alloced[i])
			return 0;
	if (env_alloced_n >= (size_t)-1 / sizeof *env_alloced) {
		errno = ENOMEM;
		return -1;
	}
	char **t = realloc(env_alloced,
		sizeof *t * (env_alloced_n+1));
	if (!t) return -1;
	env_alloced = t;
	env_alloced[env_alloced_n++] = 0;
	return 0;
}

void __env_rm_add(char *old, char *new)
{
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
	if (l1 >= KANDELO_PROCESS_METADATA_ENTRY_MAX_BYTES ||
	    l2 > KANDELO_PROCESS_METADATA_ENTRY_MAX_BYTES - l1 - 1) {
		errno = E2BIG;
		return -1;
	}
	size_t entry_len = l1 + 1 + l2;
	s = malloc(entry_len + 1);
	if (!s) return -1;
	memcpy(s, var, l1);
	s[l1] = '=';
	memcpy(s+l1+1, value, l2+1);
	return __putenv_kernel_sync(s, l1, s, var, value);
}
