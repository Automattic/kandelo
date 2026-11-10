/*
 * honest_stub_returns_test.c — prove sync_file_range and personality stop
 * claiming success.
 *
 * Both used to be dispatcher arms that returned 0 without doing anything. A
 * caller of sync_file_range believed its data had reached storage; a caller of
 * personality was told it ran under PER_LINUX, a compatibility claim Kandelo
 * does not make.
 *
 *   - sync_file_range now performs the fsync it can reach: a conservative
 *     whole-file sync is a correct implementation of a range sync, so it
 *     succeeds on a real file and fails exactly as fsync does elsewhere. The
 *     failures are what prove the call is no longer a constant: a descriptor
 *     that does not exist is EBADF, and a pipe has nothing to sync.
 *   - personality is refused with ENOSYS, and the refusal is recorded in the
 *     kernel log by name, so the gap is visible to whoever reads dmesg.
 *
 * The guest judges its own result, so a stale kernel fails here rather than
 * passing by skipping a check.
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/klog.h>
#include <sys/personality.h>
#include <unistd.h>

#define KLOG_READ_ALL 3

/* personality(2)'s query form: an argument of 0xffffffff asks for the current
 * persona without changing it. It is the call a program makes to find out. */
#define PERSONALITY_QUERY 0xffffffffUL

static char log[32768];

static int failures;

static void fail(const char *message)
{
	fprintf(stderr, "honest-stub-returns failure: %s (errno=%d: %s)\n",
	        message, errno, strerror(errno));
	failures++;
}

/* How many times `needle` occurs in the kernel log as of now, or -1. */
static int count(const char *needle)
{
	int found = 0;
	const char *at = log;
	int n = klogctl(KLOG_READ_ALL, log, (int)sizeof log - 1);
	if (n < 0) {
		fail("klogctl READ_ALL");
		return -1;
	}
	log[n] = '\0';
	while ((at = strstr(at, needle)) != NULL) {
		found++;
		at += strlen(needle);
	}
	return found;
}

int main(void)
{
	char ours[160];
	char path[] = "/tmp/honest-stub-returns-XXXXXX";
	int fd, before, after;
	int pipefd[2];

	/* sync_file_range on a descriptor that is not open. The old arm answered
	 * 0 for it, which no real implementation can. */
	errno = 0;
	if (sync_file_range(-1, 0, 0, SYNC_FILE_RANGE_WRITE) != -1 || errno != EBADF) {
		fail("sync_file_range(-1) should be EBADF, not a claim of success");
	}

	/* On a real file the call succeeds, for each of the flag combinations a
	 * caller uses to ask for durability. */
	fd = mkstemp(path);
	if (fd < 0) {
		fail("mkstemp");
	} else {
		if (write(fd, "kandelo", 7) != 7) fail("write");
		if (sync_file_range(fd, 0, 7, SYNC_FILE_RANGE_WAIT_BEFORE | SYNC_FILE_RANGE_WRITE
		                              | SYNC_FILE_RANGE_WAIT_AFTER) != 0) {
			fail("sync_file_range on a regular file should succeed");
		}
		if (sync_file_range(fd, 0, 0, SYNC_FILE_RANGE_WRITE) != 0) {
			fail("sync_file_range of the whole file (nbytes 0) should succeed");
		}
		close(fd);
		unlink(path);
	}

	/* A pipe has no storage to sync: the call fails rather than claiming it
	 * did. (The errno Linux uses differs from fsync's; only the refusal is
	 * asserted.) */
	if (pipe(pipefd) != 0) {
		fail("pipe");
	} else {
		errno = 0;
		if (sync_file_range(pipefd[1], 0, 0, SYNC_FILE_RANGE_WRITE) != -1) {
			fail("sync_file_range on a pipe should fail, not claim success");
		}
		close(pipefd[0]);
		close(pipefd[1]);
	}

	/* personality: ENOSYS, once recorded in the log with pid, number and name. */
	snprintf(ours, sizeof ours,
	         "<4>pid %d called syscall 287 (personality), which is not implemented (ENOSYS)\n",
	         (int)getpid());
	before = count(ours);
	if (before < 0) return 1;
	if (before != 0) fail("the record exists before the call was made");

	errno = 0;
	if (personality(PERSONALITY_QUERY) != -1 || errno != ENOSYS) {
		fail("personality should be ENOSYS, not the persona PER_LINUX");
	}
	after = count(ours);
	if (after != 1) {
		fprintf(stderr,
		        "honest-stub-returns failure: expected one record %s, found %d\n",
		        ours, after);
		failures++;
	}

	if (failures != 0) {
		fprintf(stderr, "honest-stub-returns-test: %d failure(s); log was:\n%s",
		        failures, log);
		return 1;
	}
	printf("honest-stub-returns-ok\n");
	return 0;
}
