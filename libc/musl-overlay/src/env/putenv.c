/*
 * putenv.c — Wasm-POSIX override of musl's putenv / __putenv.
 *
 * Prepares a fallible local mutation before synchronously updating the kernel
 * Process environment, then publishes the now-infallible libc mutation.
 */

#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <bits/kandelo_limits.h>
#include "syscall.h"

static void dummy(char *old, char *new) {}
weak_alias(dummy, __env_rm_add);

static int dummy_prepare(char *old, char *new) { return 0; }
weak_alias(dummy_prepare, __env_rm_prepare);

static char **oldenv;

struct putenv_plan {
	char *s;
	char *r;
	char **replacement;
	char **newenv;
};

static void putenv_plan_abort(struct putenv_plan *plan)
{
	free(plan->newenv);
	free(plan->r);
}

static int putenv_plan_prepare(
	struct putenv_plan *plan, char *s, size_t l, char *r)
{
	size_t i=0;
	*plan = (struct putenv_plan) {
		.s = s,
		.r = r,
	};

	if (__environ) {
		for (char **e = __environ; *e; e++, i++)
			if (!strncmp(s, *e, l+1)) {
				if (__env_rm_prepare(*e, r) < 0) {
					free(r);
					return -1;
				}
				plan->replacement = e;
				return 0;
			}
	}
	if (i > (size_t)-1 / sizeof *plan->newenv - 2) {
		errno = ENOMEM;
		free(r);
		return -1;
	}
	plan->newenv = malloc(sizeof *plan->newenv * (i+2));
	if (!plan->newenv) {
		free(r);
		return -1;
	}
	if (i) memcpy(plan->newenv, __environ, sizeof *plan->newenv * i);
	plan->newenv[i] = s;
	plan->newenv[i+1] = 0;
	if (__env_rm_prepare(0, r) < 0) {
		int saved_errno = errno;
		putenv_plan_abort(plan);
		errno = saved_errno;
		return -1;
	}
	return 0;
}

static void putenv_plan_commit(struct putenv_plan *plan)
{
	if (plan->replacement) {
		char *tmp = *plan->replacement;
		*plan->replacement = plan->s;
		__env_rm_add(tmp, plan->r);
		return;
	}

	/*
	 * All allocation, including the setenv-owned string tracking slot, was
	 * reserved before the kernel mutation. Publishing the pointer array and
	 * retiring the prior libc-owned array are therefore infallible.
	 */
	char **previous_oldenv = oldenv;
	__environ = oldenv = plan->newenv;
	plan->newenv = 0;
	free(previous_oldenv);
	if (plan->r) __env_rm_add(0, plan->r);
}

int __putenv(char *s, size_t l, char *r)
{
	struct putenv_plan plan;
	if (putenv_plan_prepare(&plan, s, l, r) < 0) return -1;
	putenv_plan_commit(&plan);
	return 0;
}

/*
 * Atomically synchronize one already-validated KEY=VALUE mutation as observed
 * at the public function boundary.
 *
 * WHY: kernel-first is safe only because putenv_plan_prepare has made the
 * following local commit allocation-free. Conversely, a kernel errno aborts
 * the unpublished plan, so libc cannot report a value the Process does not
 * own. SYS_setenv is synchronous and this libc environment API has musl's
 * existing non-concurrent mutation contract.
 */
hidden int __putenv_kernel_sync(
	char *s, size_t l, char *r, const char *name, const char *value)
{
	struct putenv_plan plan;
	if (putenv_plan_prepare(&plan, s, l, r) < 0) return -1;

	long result = __syscall3(
		SYS_setenv, (long)name, (long)value, 1);
	if (result < 0) {
		putenv_plan_abort(&plan);
		return __syscall_ret(result);
	}

	putenv_plan_commit(&plan);
	return 0;
}

int putenv(char *s)
{
	size_t l = __strchrnul(s, '=') - s;
	if (!l || !s[l]) return unsetenv(s);
	size_t entry_len = strlen(s);
	if (entry_len > KANDELO_PROCESS_METADATA_ENTRY_MAX_BYTES) {
		errno = E2BIG;
		return -1;
	}

	char *name = malloc(l + 1);
	if (!name) return -1;
	memcpy(name, s, l);
	name[l] = 0;

	int result = __putenv_kernel_sync(s, l, 0, name, s+l+1);
	int saved_errno = errno;
	free(name);
	errno = saved_errno;
	return result;
}
