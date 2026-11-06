/*
 * klogctl_test.c — prove a guest's klogctl() call reaches the kernel.
 *
 * klogctl() used to be a lie: the kernel's channel dispatch answered
 * SYS_SYSLOG with a bare 0, so a program asking for the kernel log was told
 * it had succeeded and handed nothing. ABI 56 routes Kandelo syscall 304 to
 * the kernel message ring, and this program is the end-to-end half of that
 * proof. The handler's action table is unit-tested in Rust
 * (crates/runtime-core/src/syscalls.rs); what can only be shown from a guest
 * is that a real klogctl() against the real libc, channel glue, host staging
 * and kernel dispatch arrives somewhere that knows the ring.
 *
 * The load-bearing evidence is SIZE_BUFFER: 131072 is a number only the
 * kernel holds (KMSG_CAPACITY_BYTES in crates/runtime-core/src/kmsg.rs).
 * Neither the old fake success nor an unrouted syscall number can produce
 * it; they return 0 and ENOSYS respectively. The refusals matter for the
 * same reason — a stub that reports success for every action cannot tell
 * CONSOLE_LEVEL apart from SIZE_BUFFER.
 *
 * Nothing in the kernel pushes records to the ring yet, so this program
 * asserts invariants that hold whether the ring is empty or full rather than
 * an exact record count.
 */

#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/klog.h>
#include <unistd.h>

/* Kandelo's klogctl action numbers. Source of truth: the SYSLOG_ACTION_*
 * constants in crates/runtime-core/src/syscalls.rs. */
#define KLOG_READ           2
#define KLOG_READ_ALL       3
#define KLOG_READ_CLEAR     4
#define KLOG_CLEAR          5
#define KLOG_CONSOLE_OFF    6
#define KLOG_CONSOLE_ON     7
#define KLOG_CONSOLE_LEVEL  8
#define KLOG_SIZE_UNREAD    9
#define KLOG_SIZE_BUFFER   10

/* KMSG_CAPACITY_BYTES, the fixed size of the kernel message ring. */
#define KMSG_CAPACITY_BYTES (128 * 1024)

static int failures;

static void fail(const char *message)
{
	fprintf(stderr, "klogctl failure: %s (errno=%d: %s)\n",
	        message, errno, strerror(errno));
	failures++;
}

/* Expect an action to be refused with EINVAL — never EPERM, which is what the
 * libc glue used to answer for every klogctl action. */
static void expect_einval(int action, const char *what)
{
	errno = 0;
	if (klogctl(action, NULL, 0) != -1) {
		fail(what);
		return;
	}
	if (errno != EINVAL) fail(what);
}

int main(void)
{
	char buffer[4096];
	int size_buffer;
	int unread;
	int read_all;

	/* The routing proof: the ring's capacity is kernel-side knowledge. */
	errno = 0;
	size_buffer = klogctl(KLOG_SIZE_BUFFER, NULL, 0);
	if (size_buffer != KMSG_CAPACITY_BYTES) {
		fprintf(stderr,
		        "klogctl failure: SIZE_BUFFER returned %d, expected %d"
		        " (errno=%d: %s)\n",
		        size_buffer, KMSG_CAPACITY_BYTES, errno, strerror(errno));
		failures++;
	}

	/* Reads are unrestricted and report a count, never an error. */
	errno = 0;
	unread = klogctl(KLOG_SIZE_UNREAD, NULL, 0);
	if (unread < 0) fail("SIZE_UNREAD");
	if (unread > KMSG_CAPACITY_BYTES) fail("SIZE_UNREAD exceeds the ring");

	/* The counting actions write nothing, so their result is a count and not
	 * a transfer length. Handing them a buffer is refused rather than left to
	 * make the result claim a transfer that never happened. */
	errno = 0;
	if (klogctl(KLOG_SIZE_BUFFER, buffer, (int)sizeof buffer) != -1
	    || errno != EINVAL) {
		fail("SIZE_BUFFER with a buffer should be EINVAL");
	}
	errno = 0;
	if (klogctl(KLOG_SIZE_UNREAD, buffer, (int)sizeof buffer) != -1
	    || errno != EINVAL) {
		fail("SIZE_UNREAD with a buffer should be EINVAL");
	}

	errno = 0;
	read_all = klogctl(KLOG_READ_ALL, buffer, (int)sizeof buffer);
	if (read_all < 0) fail("READ_ALL");
	if (read_all > (int)sizeof buffer) fail("READ_ALL overran its buffer");
	/* Every rendered record opens with its `<pri>` prefix. */
	if (read_all > 0 && buffer[0] != '<') fail("READ_ALL lost the pri prefix");

	/* READ_ALL consumes nothing, so a second call sees the same bytes. */
	errno = 0;
	if (klogctl(KLOG_READ_ALL, buffer, (int)sizeof buffer) != read_all) {
		fail("READ_ALL consumed records");
	}

	errno = 0;
	if (klogctl(KLOG_READ, buffer, (int)sizeof buffer) < 0) fail("READ");

	/* There is no console log level to turn off, on, or set. */
	expect_einval(KLOG_CONSOLE_OFF, "CONSOLE_OFF should be EINVAL");
	expect_einval(KLOG_CONSOLE_ON, "CONSOLE_ON should be EINVAL");
	expect_einval(KLOG_CONSOLE_LEVEL, "CONSOLE_LEVEL should be EINVAL");

	/* Actions this kernel does not implement, including the numbers Linux
	 * calls CLOSE and OPEN: Kandelo keeps no per-caller klogctl state. */
	expect_einval(0, "action 0 should be EINVAL");
	expect_einval(1, "action 1 should be EINVAL");
	expect_einval(11, "action 11 should be EINVAL");
	expect_einval(-1, "action -1 should be EINVAL");

	/* Clearing destroys state every reader shares, so only root may do it.
	 * Exercise whichever side of that gate this process is actually on. */
	if (geteuid() == 0) {
		errno = 0;
		if (klogctl(KLOG_CLEAR, NULL, 0) != 0) fail("root CLEAR");
		errno = 0;
		if (klogctl(KLOG_SIZE_UNREAD, NULL, 0) != 0) {
			fail("CLEAR left unread records behind");
		}
		errno = 0;
		if (klogctl(KLOG_READ_CLEAR, buffer, (int)sizeof buffer) != 0) {
			fail("root READ_CLEAR on an empty ring");
		}
	} else {
		errno = 0;
		if (klogctl(KLOG_CLEAR, NULL, 0) != -1 || errno != EPERM) {
			fail("non-root CLEAR should be EPERM");
		}
		/* Authority is decided before request shape: passing a buffer
		 * CLEAR does not take must not turn EPERM into EINVAL, or the
		 * refusal a caller sees depends on an unrelated mistake. */
		errno = 0;
		if (klogctl(KLOG_CLEAR, buffer, (int)sizeof buffer) != -1
		    || errno != EPERM) {
			fail("non-root CLEAR with a buffer should still be EPERM");
		}
		errno = 0;
		if (klogctl(KLOG_READ_CLEAR, buffer, (int)sizeof buffer) != -1
		    || errno != EPERM) {
			fail("non-root READ_CLEAR should be EPERM");
		}
		/* A refused clear must not have cost this reader its reads. */
		errno = 0;
		if (klogctl(KLOG_SIZE_UNREAD, NULL, 0) < 0) {
			fail("SIZE_UNREAD after a refused clear");
		}
	}

	if (failures != 0) {
		fprintf(stderr, "klogctl-test: %d failure(s)\n", failures);
		return 1;
	}
	printf("klogctl-ok\n");
	return 0;
}
