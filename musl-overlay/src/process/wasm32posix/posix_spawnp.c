/*
 * posix_spawnp() for wasm32posix — PATH search in libc, then plain
 * posix_spawn() with the resolved absolute path.
 *
 * Why this overrides the upstream musl version:
 *   musl's posix_spawnp installs __execvpe in attr->__fn, then relies on
 *   the forked child to do the PATH search via execvpe. Our posix_spawn
 *   no longer forks (see ./posix_spawn.c) and never does an exec inside
 *   the child — the host instantiates the resolved program directly.
 *   PATH search must therefore happen here, in the parent.
 *
 * See docs/plans/2026-05-04-non-forking-posix-spawn-design.md (Q1
 * Option A — "PATH search in libc").
 */

#define _GNU_SOURCE
#include <spawn.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

int posix_spawnp(pid_t *restrict res, const char *restrict file,
	const posix_spawn_file_actions_t *fa,
	const posix_spawnattr_t *restrict attr,
	char *const argv[restrict], char *const envp[restrict])
{
	if (!file) return EINVAL;

	/* If the name contains '/', POSIX says no PATH search — pass through
	 * to plain posix_spawn(). */
	if (strchr(file, '/')) {
		return posix_spawn(res, file, fa, attr, argv, envp);
	}

	const char *path = getenv("PATH");
	if (!path) path = "/usr/local/bin:/bin:/usr/bin";

	/* Walk PATH entries; try each. Match __execvpe's EACCES-defer rule:
	 * if any candidate fails with EACCES, keep trying — only if every
	 * candidate fails with ENOENT/ENOTDIR do we report ENOENT. If we
	 * saw an EACCES along the way, surface that instead. */
	int saw_eacces = 0;
	char buf[4096];
	const char *p = path;
	for (;;) {
		const char *colon = strchr(p, ':');
		size_t len = colon ? (size_t)(colon - p) : strlen(p);
		size_t needed;
		if (len == 0) {
			/* Empty PATH entry == "." per POSIX. */
			buf[0] = '.';
			buf[1] = '/';
			needed = 2 + strlen(file);
			if (needed + 1 > sizeof(buf)) goto skip;
			strcpy(buf + 2, file);
		} else {
			needed = len + 1 + strlen(file);
			if (needed + 1 > sizeof(buf)) goto skip;
			memcpy(buf, p, len);
			buf[len] = '/';
			strcpy(buf + len + 1, file);
		}

		int rc = posix_spawn(res, buf, fa, attr, argv, envp);
		switch (rc) {
		case 0:        return 0;
		case ENOENT:
		case ENOTDIR:  break;            /* try next entry */
		case EACCES:   saw_eacces = 1;   /* defer; try next */
		               break;
		default:       return rc;        /* hard error — stop */
		}

skip:
		if (!colon) break;
		p = colon + 1;
	}
	return saw_eacces ? EACCES : ENOENT;
}
