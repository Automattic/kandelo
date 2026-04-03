/*
 * posix_spawn() for wasm32posix — uses fork() + exec pattern.
 *
 * In the asyncify fork model, the child resumes from the fork point with
 * the full stack and heap intact.  The child applies file actions directly
 * via dup2/close/open syscalls before calling execve.
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

int posix_spawn(pid_t *restrict res, const char *restrict path,
	const posix_spawn_file_actions_t *fa,
	const posix_spawnattr_t *restrict attr,
	char *const argv[restrict], char *const envp[restrict])
{
	if (!path) return EINVAL;

	pid_t pid = fork();

	if (pid < 0) {
		return errno;
	}

	if (pid == 0) {
		/* Child: apply file actions then exec */

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
					ret = dup2(op->srcfd, op->fd);
					if (ret < 0) _exit(127);
					break;
				case FDOP_OPEN:
					ret = open(op->path, op->oflag, op->mode);
					if (ret < 0) _exit(127);
					if (ret != op->fd) {
						if (dup2(ret, op->fd) < 0) _exit(127);
						close(ret);
					}
					break;
				}
			}
		}

		/* Exec the new program */
		if (envp) {
			execve(path, argv, envp);
		} else {
			extern char **__environ;
			execve(path, argv, __environ);
		}
		_exit(127);
	}

	/* Parent: pid > 0 */
	if (res) *res = pid;
	return 0;
}
