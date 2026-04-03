/*
 * posix_spawn() for wasm32posix — uses fork() + exec pattern.
 *
 * In the asyncify fork model, the child resumes from the fork point with
 * the full stack and heap intact.  The child applies spawn attributes and
 * file actions directly before calling execve (or attr->__fn for spawnp).
 */

#define _GNU_SOURCE
#include <spawn.h>
#include <unistd.h>
#include <signal.h>
#include <fcntl.h>
#include <errno.h>
#include <string.h>
#include <sys/wait.h>
#include <stdlib.h>
#include <stdint.h>
#include "../fdop.h"

static const posix_spawnattr_t empty_attr;

int posix_spawn(pid_t *restrict res, const char *restrict path,
	const posix_spawn_file_actions_t *fa,
	const posix_spawnattr_t *restrict attr,
	char *const argv[restrict], char *const envp[restrict])
{
	if (!path) return EINVAL;

	const posix_spawnattr_t *a = attr ? attr : &empty_attr;

	pid_t pid = fork();

	if (pid < 0) {
		return errno;
	}

	if (pid == 0) {
		/* Child: apply attributes, file actions, then exec */

		/* Apply spawn attributes before file actions (matching POSIX order) */
		if (a->__flags & POSIX_SPAWN_SETSIGDEF) {
			struct sigaction sa = {0};
			sa.sa_handler = SIG_DFL;
			for (int i = 1; i < _NSIG; i++) {
				if (sigismember(&a->__def, i))
					sigaction(i, &sa, 0);
			}
		}

		if (a->__flags & POSIX_SPAWN_SETSID) {
			setsid();
		}

		if (a->__flags & POSIX_SPAWN_SETPGROUP) {
			if (setpgid(0, a->__pgrp) < 0)
				_exit(127);
		}

		if (a->__flags & POSIX_SPAWN_SETSIGMASK) {
			sigprocmask(SIG_SETMASK, &a->__mask, 0);
		}

		/* Apply file actions directly via syscalls */
		if (fa && fa->__actions) {
			struct fdop *op;
			/* Walk to the end of the list */
			for (op = fa->__actions; op->next; op = op->next);
			/* Apply in reverse order (matching musl's convention) */
			for (; op; op = op->prev) {
				int ret;
				switch (op->cmd) {
				case FDOP_CLOSE:
					close(op->fd);
					break;
				case FDOP_DUP2:
					if (op->srcfd != op->fd) {
						ret = dup2(op->srcfd, op->fd);
						if (ret < 0) _exit(127);
					} else {
						/* Self-dup: clear FD_CLOEXEC per POSIX */
						int flags = fcntl(op->fd, F_GETFD);
						if (flags < 0) _exit(127);
						if (fcntl(op->fd, F_SETFD, flags & ~FD_CLOEXEC) < 0)
							_exit(127);
					}
					break;
				case FDOP_OPEN:
					ret = open(op->path, op->oflag, op->mode);
					if (ret < 0) _exit(127);
					if (ret != op->fd) {
						if (dup2(ret, op->fd) < 0) _exit(127);
						close(ret);
					}
					break;
				case FDOP_CHDIR:
					if (chdir(op->path) < 0) _exit(127);
					break;
				case FDOP_FCHDIR:
					if (fchdir(op->fd) < 0) _exit(127);
					break;
				}
			}
		}

		/* Exec the new program.
		 * Use attr->__fn if set (posix_spawnp sets this to __execvpe
		 * for PATH searching). */
		int (*exec_fn)(const char *, char *const *, char *const *) =
			a->__fn ? (int (*)(const char *, char *const *, char *const *))a->__fn
			        : execve;

		if (envp) {
			exec_fn(path, argv, envp);
		} else {
			extern char **__environ;
			exec_fn(path, argv, __environ);
		}
		_exit(127);
	}

	/* Parent: pid > 0 */
	if (res) *res = pid;
	return 0;
}
