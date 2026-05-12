/*
 * spawn-smoke.c — minimal posix_spawn user program for the
 * non-forking spawn smoke test.
 *
 * Usage:
 *   spawn-smoke                       # spawns /bin/echo "spawned-ok"
 *   spawn-smoke /path/to/program ...  # spawns the given program
 *
 * Verified by host/test/centralized-spawn.test.ts (Task 18).
 *
 * The program asserts:
 *   1. posix_spawn() returns 0.
 *   2. waitpid() reaps the child.
 *   3. The child exited normally with status 0.
 *
 * On success it prints "OK\n" to stdout. On failure it prints a
 * specific diagnostic to stderr and exits non-zero so the test can
 * distinguish error modes (spawn failed vs. child failed vs. waitpid
 * failed).
 */

#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

int main(int argc, char **argv) {
	const char *child_path = (argc > 1) ? argv[1] : "/bin/echo";
	char *child_argv[] = { (char *)child_path, "spawned-ok", NULL };

	pid_t pid;
	int rc = posix_spawn(&pid, child_path, NULL, NULL, child_argv, environ);
	if (rc != 0) {
		fprintf(stderr, "posix_spawn(%s): %s\n", child_path, strerror(rc));
		return 1;
	}

	int status;
	if (waitpid(pid, &status, 0) < 0) {
		perror("waitpid");
		return 2;
	}
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
		fprintf(stderr, "child exited %d (signal %d)\n",
			WIFEXITED(status) ? WEXITSTATUS(status) : -1,
			WIFSIGNALED(status) ? WTERMSIG(status) : 0);
		return 3;
	}

	printf("OK\n");
	return 0;
}
