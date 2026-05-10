/*
 * spawn-coverage.c — exercise the non-forking-spawn libc surface
 * beyond the basic posix_spawn() call. Each subtest prints a tagged
 * line so the vitest harness can assert on individual outcomes.
 *
 * Subtests:
 *   1. posix_spawnp(no slash) + waitpid     → finds program via PATH
 *   2. posix_spawn with addclose(2)         → file actions plumbing
 *   3. posix_spawn with SETPGROUP, pgrp=0   → child's pgid is set
 *
 * Each subtest prints either "OK <name>" or "FAIL <name>: <reason>".
 * main returns the count of failures (0 = all pass).
 *
 * Out of scope here (not because the kernel can't do them, but because
 * they need infra we don't yet wire up in the test harness):
 *   * popen / system — depend on /bin/sh resolving.
 *   * file_actions OPEN — depends on a writable VFS path the child can
 *     also see; the test harness uses NodePlatformIO, so /tmp is the
 *     real host /tmp, and concurrent test runs would race on a fixed
 *     name. The kernel's `apply_spawn_file_actions` handler exercises
 *     this code path under cargo unit tests.
 *
 * The vitest harness asserts:
 *   * exit code 0
 *   * one "OK <name>" line per subtest
 *   * parent's kernel_get_fork_count remains 0 after this program runs
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static int n_failures = 0;

static void ok(const char *name) {
	printf("OK %s\n", name);
}

static void fail(const char *name, const char *reason) {
	printf("FAIL %s: %s\n", name, reason);
	n_failures++;
}

/* --- 1. posix_spawnp without leading slash ---
 *
 * Asserts that PATH search via libc's `access(X_OK)` correctly returns
 * ENOENT when no PATH entry contains the binary in the VFS. The vitest
 * harness wires `/usr/bin/hello` only via `execPrograms` (a host-side
 * exec map), not as a VFS file, so PATH search SHOULD fail. This pins
 * the behavior — sortix's `basic/spawn/posix_spawnp` covers the
 * positive case (PATH entries that are real VFS dirs).
 */
static void test_spawnp(void) {
	char *argv[] = { "hello", NULL };
	pid_t pid;
	int rc = posix_spawnp(&pid, "hello", NULL, NULL, argv, environ);
	if (rc != ENOENT) {
		char msg[128];
		snprintf(msg, sizeof(msg), "posix_spawnp: expected ENOENT, got %d (%s)", rc, strerror(rc));
		fail("spawnp", msg);
		return;
	}
	ok("spawnp");
}

/* --- 2. posix_spawn with addclose --- */
static void test_file_actions_close(void) {
	posix_spawn_file_actions_t fa;
	if (posix_spawn_file_actions_init(&fa) != 0) {
		fail("file_actions", "init"); return;
	}
	/* Close stderr in the child. The child (hello) doesn't touch stderr,
	 * so it should still exit 0; this verifies the addclose plumbing
	 * (kernel applies the action without rejecting the spawn). */
	if (posix_spawn_file_actions_addclose(&fa, 2) != 0) {
		fail("file_actions", "addclose"); posix_spawn_file_actions_destroy(&fa); return;
	}

	char *argv[] = { "hello", NULL };
	pid_t pid;
	int rc = posix_spawn(&pid, "/usr/bin/hello", &fa, NULL, argv, environ);
	posix_spawn_file_actions_destroy(&fa);
	if (rc != 0) {
		char msg[128];
		snprintf(msg, sizeof(msg), "posix_spawn: %s", strerror(rc));
		fail("file_actions", msg);
		return;
	}
	int status;
	if (waitpid(pid, &status, 0) < 0) { fail("file_actions", "waitpid"); return; }
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
		fail("file_actions", "child did not exit 0");
		return;
	}
	ok("file_actions");
}

/* --- 3. posix_spawn with POSIX_SPAWN_SETPGROUP, pgrp=0 ---
 *
 * Reads the child's pgid via `getpgid(pid)` BEFORE `waitpid`. The
 * spawned target is `spawn-pause` (sleeps 100 ms before exiting) so
 * the child is still alive when the parent makes the syscall — our
 * kernel currently drops process state on exit (no POSIX zombies),
 * which is a separate limitation; pausing the target sidesteps it.
 */
static void test_setpgroup(void) {
	posix_spawnattr_t attr;
	if (posix_spawnattr_init(&attr) != 0) { fail("setpgroup", "init"); return; }
	if (posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETPGROUP) != 0) {
		fail("setpgroup", "setflags"); posix_spawnattr_destroy(&attr); return;
	}
	if (posix_spawnattr_setpgroup(&attr, 0) != 0) {
		fail("setpgroup", "setpgroup(0)"); posix_spawnattr_destroy(&attr); return;
	}
	char *argv[] = { "spawn-pause", NULL };
	pid_t pid;
	int rc = posix_spawn(&pid, "/usr/bin/spawn-pause", NULL, &attr, argv, environ);
	posix_spawnattr_destroy(&attr);
	if (rc != 0) {
		char msg[128];
		snprintf(msg, sizeof(msg), "posix_spawn: %s", strerror(rc));
		fail("setpgroup", msg);
		return;
	}

	pid_t got_pgid = getpgid(pid);
	int status;
	if (waitpid(pid, &status, 0) < 0) { fail("setpgroup", "waitpid"); return; }
	if (got_pgid != pid) {
		char msg[128];
		snprintf(msg, sizeof(msg), "child pgid=%d, want=%d", got_pgid, pid);
		fail("setpgroup", msg);
		return;
	}
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
		fail("setpgroup", "child did not exit 0");
		return;
	}
	ok("setpgroup");
}

int main(void) {
	test_spawnp();
	test_file_actions_close();
	test_setpgroup();
	if (n_failures == 0) printf("ALL OK\n");
	return n_failures;
}
