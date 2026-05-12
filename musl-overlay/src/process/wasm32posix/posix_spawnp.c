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
 * One non-obvious wrinkle: PATH search has to honor any chdir/fchdir
 * file actions BEFORE walking PATH. The sortix
 * `basic/spawn/posix_spawn_file_actions_addchdir` test does exactly:
 *     setenv("PATH", ".", 1);
 *     addchdir(&fa, "spawn");
 *     posix_spawnp(prog, &fa, ...);
 * and expects PATH=. to resolve relative to the post-chdir directory.
 *
 * To get this right we:
 *   1. Snapshot the caller's cwd.
 *   2. Apply chdir/fchdir actions transiently in the caller.
 *   3. Walk PATH using `access(candidate, X_OK)` — never call
 *      posix_spawn while the caller's cwd is moved.
 *   4. Canonicalize the matching candidate to an absolute path via
 *      realpath() so the kernel and child see the same name.
 *   5. RESTORE the caller's cwd. (Critical: the spawn child inherits
 *      the caller's kernel cwd at posix_spawn time. If we leave the
 *      transient chdir in place, the child's own chdir file action
 *      would apply on top, double-counting the move.)
 *   6. Call posix_spawn with the resolved absolute path.
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
#include <limits.h>
#include "../fdop.h"

/* Apply chdir/fchdir actions in INSERTION order (musl's fdop list is
 * stored in reverse-insertion order — head is most recent). Returns 0
 * if successful (or no chdir actions), or the errno of the first
 * failed chdir/fchdir. On failure, restores cwd to `saved_cwd`. */
static int apply_transient_chdir_actions(
	const posix_spawn_file_actions_t *fa,
	const char *saved_cwd,
	int *out_cwd_changed)
{
	*out_cwd_changed = 0;
	if (!fa || !fa->__actions) return 0;

	struct fdop *tail = (struct fdop *)fa->__actions;
	while (tail->next) tail = tail->next;

	for (struct fdop *op = tail; op; op = op->prev) {
		if (op->cmd == FDOP_CHDIR) {
			if (chdir(op->path) < 0) {
				int saved_errno = errno;
				if (*out_cwd_changed && saved_cwd[0]) chdir(saved_cwd);
				return saved_errno;
			}
			*out_cwd_changed = 1;
		} else if (op->cmd == FDOP_FCHDIR) {
			if (fchdir(op->fd) < 0) {
				int saved_errno = errno;
				if (*out_cwd_changed && saved_cwd[0]) chdir(saved_cwd);
				return saved_errno;
			}
			*out_cwd_changed = 1;
		}
	}
	return 0;
}

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

	/* ── Pre-flight: snapshot cwd, apply chdir/fchdir actions transiently,
	 *    walk PATH using access(), canonicalize to absolute, restore cwd. */
	char saved_cwd[PATH_MAX] = {0};
	int cwd_changed = 0;
	int chdir_err = 0;

	if (fa && fa->__actions) {
		if (!getcwd(saved_cwd, sizeof(saved_cwd))) {
			/* Can't snapshot cwd — proceed without applying transient
			 * chdir; PATH search runs against caller's actual cwd.
			 * For the addchdir test this means we won't find the
			 * program, but for callers that don't pass chdir actions
			 * this is fine. */
			saved_cwd[0] = '\0';
		} else {
			chdir_err = apply_transient_chdir_actions(fa, saved_cwd, &cwd_changed);
			if (chdir_err) {
				/* The child's own chdir file_action would fail with the
				 * same error; surface it to the caller now. */
				return chdir_err;
			}
		}
	}

	/* Walk PATH. For each candidate, check access(X_OK). Match
	 * __execvpe's EACCES-defer rule. We DO NOT call posix_spawn while
	 * cwd is moved — only after restoring caller's cwd, with the
	 * resolved absolute path. */
	int saw_eacces = 0;
	int found = 0;
	char buf[PATH_MAX];
	char abs_buf[PATH_MAX];
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

		if (access(buf, X_OK) == 0) {
			/* Canonicalize to absolute. realpath() resolves relative to
			 * the current (transiently chdir'd) cwd. */
			if (realpath(buf, abs_buf)) {
				found = 1;
				break;
			}
			/* realpath failed — fall through and try next. */
		} else if (errno == EACCES) {
			saw_eacces = 1;
		}

skip:
		if (!colon) break;
		p = colon + 1;
	}

	/* Restore caller's cwd before calling posix_spawn — the child
	 * inherits the caller's cwd at spawn time, and the child's own
	 * chdir file_action (if any) will reapply the move. */
	if (cwd_changed && saved_cwd[0]) {
		chdir(saved_cwd);
	}

	if (!found) {
		return saw_eacces ? EACCES : ENOENT;
	}

	return posix_spawn(res, abs_buf, fa, attr, argv, envp);
}
