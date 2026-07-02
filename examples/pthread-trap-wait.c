/*
 * pthread-trap-wait.c - parent observes pthread trap via waitpid status.
 */

#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

int main(int argc, char **argv)
{
	const char *child_path = argc > 1 ? argv[1] : "/pthread-trap-child";
	char *child_argv[] = { (char *)child_path, 0 };
	pid_t pid = 0;

	int rc = posix_spawn(&pid, child_path, 0, 0, child_argv, environ);
	if (rc != 0) {
		fprintf(stderr, "posix_spawn(%s): %s\n", child_path, strerror(rc));
		return 1;
	}

	int status = 0;
	if (waitpid(pid, &status, 0) < 0) {
		perror("waitpid");
		return 2;
	}

	printf("waitpid child=%d status=%d signaled=%d termsig=%d exited=%d exit=%d\n",
		(int)pid,
		status,
		WIFSIGNALED(status),
		WIFSIGNALED(status) ? WTERMSIG(status) : 0,
		WIFEXITED(status),
		WIFEXITED(status) ? WEXITSTATUS(status) : -1);

	if (!WIFSIGNALED(status)) return 3;
	if (WTERMSIG(status) != SIGILL) return 4;

	puts("PASS pthread trap wait status");
	return 0;
}
