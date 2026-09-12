/*
 * Shared scaffolding for the System V IPC conformance tests.
 *
 * WHY THIS HEADER EXISTS: the upstream os-test SysV cases
 * (basic/sys_shm/shmget.c, basic/sys_sem/semop.c, basic/sys_msg/msgsnd.c)
 * assert only that a call returns a non-negative value. None of them reads a
 * value back, observes a second process, blocks, or checks an errno. A
 * System V implementation that allocated identifiers and discarded every
 * byte written through them would pass all three.
 *
 * The tests using this header assert semantics instead: what a later call
 * must observe, which errno a misuse must produce, and what a second process
 * must see. Diagnostics go to stdout, because the runner captures the guest's
 * stdout and compares exit status only -- a failure that writes nowhere
 * readable reduces to a bare "exit: 1".
 */

#ifndef KANDELO_SYSV_H
#define KANDELO_SYSV_H

#include <sys/ipc.h>

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "basic.h"

/*
 * POSIX specifies that the application, not the system headers, defines
 * `union semun` for semctl's variadic argument.
 */
union semun {
	int val;
	struct semid_ds *buf;
	unsigned short *array;
};

/* The test name each diagnostic is prefixed with; each .c file defines it. */
#ifndef SYSV_TEST_NAME
#error "define SYSV_TEST_NAME before including sysv.h"
#endif

#define FAILF(...) \
	do { \
		printf("%s: ", SYSV_TEST_NAME); \
		printf(__VA_ARGS__); \
		printf("\n"); \
		fflush(stdout); \
		_exit(1); \
	} while (0)

#define FAIL_ERRNO(what) FAILF("%s: %s", (what), strerrno(errno))

/*
 * Assert that a call failed with a specific errno.
 *
 * Both halves matter. A call that unexpectedly SUCCEEDS is the more
 * interesting failure for the error-path cases below: it means the
 * implementation accepted something POSIX requires it to reject, which is
 * precisely the class of defect a smoke test cannot see.
 */
#define EXPECT_ERRNO(expr, want, what) \
	do { \
		errno = 0; \
		long rc_ = (long)(expr); \
		if ( rc_ >= 0 ) \
			FAILF("%s: expected %s, but the call succeeded (%ld)", \
			      (what), strerrno(want), rc_); \
		if ( errno != (want) ) \
			FAILF("%s: expected %s, got %s", (what), \
			      strerrno(want), strerrno(errno)); \
	} while (0)

#endif
