/*
 * enosys_report_test.c — prove a syscall the kernel has no implementation for
 * leaves a record in the kernel log, that an ordinary failure (including an
 * ENOSYS an implemented syscall returns for an argument it rejects) does not,
 * and that a sweep of made-up syscall numbers cannot flood the log.
 *
 * Kandelo's kernel log (read here through klogctl) answers "what did this
 * program ask for that Kandelo lacks?". The Rust unit tests prove the
 * reporting call itself; what only a guest can show is that the dispatcher's
 * unimplemented-syscall arms actually reach it, through the real libc, channel
 * glue, host staging and kernel dispatch.
 *
 * The unimplemented syscall used is inotify_init1 (Kandelo number 247). It is
 * a deliberate, documented refusal (docs/posix-status.md): a fake-success
 * descriptor that never delivers events would defeat the polling fallbacks of
 * Qt's QFileSystemWatcher and glib's GFileMonitor, which take them only when
 * inotify_init fails. Implementing it is a design reversal, not a routine gap
 * closed, so this test is not expected to go stale. If it ever does, the guest
 * fails loudly below and says so; it never passes by skipping the check.
 *
 * The test measures deltas. It does not assume the log starts empty, or that
 * nothing else at startup was refused.
 */

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/klog.h>
#include <sys/syscall.h>
#include <unistd.h>

#define KLOG_READ_ALL 3

/* KMSG_RATE_BURST (crates/runtime-core/src/kmsg.rs): records one callsite may
 * write per window. Unknown syscall numbers share one callsite. */
#define KMSG_RATE_BURST 10

/* Numbers above every dispatcher arm (the highest is 415) and below the
 * host-intercepted spawn (500): no syscall at all. */
#define UNKNOWN_FIRST 450
#define UNKNOWN_LAST 499

/* An operation futex does not support: its own handler answers ENOSYS. */
#define NO_SUCH_FUTEX_OP 99

/* The ring holds 128 KiB; a fresh machine's log is a few hundred bytes. READ_ALL
 * returns the newest whole records that fit, which is every record that
 * matters here. */
static char log[32768];

static int failures;

static void fail(const char *message)
{
	fprintf(stderr, "enosys-report failure: %s (errno=%d: %s)\n",
	        message, errno, strerror(errno));
	failures++;
}

/* Read the whole log, NUL-terminated. Returns its length, or -1. */
static int read_log(void)
{
	int n = klogctl(KLOG_READ_ALL, log, (int)sizeof log - 1);
	if (n < 0) {
		fail("klogctl READ_ALL");
		return -1;
	}
	log[n] = '\0';
	return n;
}

/* How many times `needle` occurs in the log as of now. */
static int count(const char *needle)
{
	int found = 0;
	const char *at = log;
	if (read_log() < 0) return -1;
	while ((at = strstr(at, needle)) != NULL) {
		found++;
		at += strlen(needle);
	}
	return found;
}

/* How many records at priority `pri` (such as "<4>") carry exactly `text`,
 * including its newline. The log renders each record as one line,
 * `<pri>[seconds.microseconds] text`, Linux's printk_time form (see
 * crates/runtime-core/src/klogctl.rs). */
static int count_record(const char *pri, const char *text)
{
	int found = 0;
	size_t pri_len = strlen(pri), text_len = strlen(text);
	const char *line = log;
	if (read_log() < 0) return -1;
	while (*line != '\0') {
		const char *end = strchr(line, '\n');
		size_t len = end != NULL ? (size_t)(end - line) + 1 : strlen(line);
		const char *close = memchr(line, ']', len);
		if (strncmp(line, pri, pri_len) == 0 && line[pri_len] == '[' &&
		    close != NULL && close[1] == ' ' &&
		    (size_t)(line + len - (close + 2)) == text_len &&
		    strncmp(close + 2, text, text_len) == 0)
			found++;
		line += len;
	}
	return found;
}

int main(void)
{
	static const char any_report[] = "which is not implemented (ENOSYS)";
	char ours[160];
	int before_all, before_ours, mid_all, after_all, after_ours;
	int before_unknown, after_unknown, n;
	int fd;
	int futex_word = 0;

	/* The record that must appear: this process, this syscall, its number and
	 * name, at warning severity (<4>: facility kern, level warning). */
	snprintf(ours, sizeof ours,
	         "pid %d called syscall 247 (inotify_init1), %s\n",
	         (int)getpid(), any_report);

	before_all = count(any_report);
	before_ours = count_record("<4>", ours);
	if (before_all < 0 || before_ours < 0) return 1;
	if (before_ours != 0) fail("the record exists before the call was made");

	/* Implemented syscalls failing in the ordinary way are the caller's error
	 * and must leave no report. */
	errno = 0;
	if (close(-1) != -1 || errno != EBADF) fail("close(-1) should be EBADF");
	errno = 0;
	if (open("/no/such/file", O_RDONLY) != -1 || errno != ENOENT) {
		fail("open of a missing path should be ENOENT");
	}
	errno = 0;
	if (lseek(-1, 0, SEEK_SET) != -1 || errno != EBADF) {
		fail("lseek(-1) should be EBADF");
	}
	/* futex exists. An operation it does not support is refused by futex's own
	 * handler with ENOSYS: a rejected argument, not a missing syscall, and it
	 * must not be listed as one. */
	errno = 0;
	if (syscall(SYS_futex, &futex_word, NO_SUCH_FUTEX_OP, 0, NULL, NULL, 0) != -1
	    || errno != ENOSYS) {
		fail("futex with an unsupported operation should be ENOSYS");
	}
	mid_all = count(any_report);
	if (mid_all != before_all) {
		fail("an implemented syscall's ordinary failure was reported as unimplemented");
	}

	/* The unimplemented syscall: the program must be told ENOSYS ... */
	errno = 0;
	fd = (int)syscall(SYS_inotify_init1, 0);
	if (fd >= 0) {
		close(fd);
		fprintf(stderr,
		        "enosys-report failure: inotify_init1 succeeded. It is no longer"
		        " unimplemented, so this test no longer exercises the ENOSYS"
		        " report: pick a syscall that still is\n");
		return 1;
	}
	if (errno != ENOSYS) fail("inotify_init1 should be ENOSYS");

	/* ... and the log must say so, once, with the pid, number and name. */
	after_all = count(any_report);
	after_ours = count_record("<4>", ours);
	if (after_ours != 1) {
		fprintf(stderr,
		        "enosys-report failure: expected one record %s, found %d\n",
		        ours, after_ours);
		failures++;
	}
	if (after_all != before_all + 1) {
		fprintf(stderr,
		        "enosys-report failure: expected one new unimplemented-syscall"
		        " record, the count went %d -> %d\n", before_all, after_all);
		failures++;
	}

	/* A program that makes up syscall numbers must not be able to write the
	 * log full: unknown numbers share one rate limit. Fifty distinct numbers
	 * add at most one burst of records, not one burst each. */
	before_unknown = count("unknown syscall ");
	for (n = UNKNOWN_FIRST; n <= UNKNOWN_LAST; n++) {
		errno = 0;
		if (syscall(n) != -1 || errno != ENOSYS) fail("an unknown syscall should be ENOSYS");
	}
	after_unknown = count("unknown syscall ");
	if (after_unknown - before_unknown < 1
	    || after_unknown - before_unknown > KMSG_RATE_BURST) {
		fprintf(stderr,
		        "enosys-report failure: %d unknown syscall numbers wrote %d records,"
		        " expected between 1 and %d\n",
		        UNKNOWN_LAST - UNKNOWN_FIRST + 1, after_unknown - before_unknown,
		        KMSG_RATE_BURST);
		failures++;
	}
	/* ... and the flood spent none of a named stub's budget. */
	errno = 0;
	if (syscall(SYS_inotify_add_watch, -1, "/", 0) != -1 || errno != ENOSYS) {
		fail("inotify_add_watch should be ENOSYS");
	}
	snprintf(ours, sizeof ours,
	         "pid %d called syscall 248 (inotify_add_watch), %s\n",
	         (int)getpid(), any_report);
	if (count_record("<4>", ours) != 1) fail("inotify_add_watch was not reported after the sweep");

	if (failures != 0) {
		fprintf(stderr, "enosys-report-test: %d failure(s); log was:\n%s",
		        failures, log);
		return 1;
	}
	printf("enosys-report-ok\n");
	return 0;
}
