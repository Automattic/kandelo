#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <mqueue.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/statfs.h>
#include <sys/sysinfo.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

static unsigned char alternate_stack[SIGSTKSZ];
static volatile sig_atomic_t queued_handler_seen;
static volatile sig_atomic_t queued_handler_valid;
static uintptr_t queued_handler_expected_value;
static pid_t queued_handler_expected_pid;

static void queued_siginfo_handler(int signo, siginfo_t *info, void *context)
{
	uintptr_t observed_value;

	(void)context;
	if (info == NULL) {
		queued_handler_valid = 0;
		queued_handler_seen = 1;
		return;
	}
#if UINTPTR_MAX > UINT32_MAX
	observed_value = (uintptr_t)info->si_value.sival_ptr;
#else
	observed_value = (uintptr_t)(uint32_t)info->si_value.sival_int;
#endif
	queued_handler_valid =
		signo == SIGUSR2 &&
		info->si_signo == SIGUSR2 &&
		info->si_code == SI_QUEUE &&
		info->si_pid == queued_handler_expected_pid &&
		observed_value == queued_handler_expected_value;
	queued_handler_seen = 1;
}

static int test_sigaltstack_layout(void)
{
	stack_t requested = {
		.ss_sp = alternate_stack,
		.ss_flags = 0,
		.ss_size = sizeof(alternate_stack),
	};
	stack_t previous;
	stack_t observed;
	stack_t disabled = {
		.ss_sp = NULL,
		.ss_flags = SS_DISABLE,
		.ss_size = 0,
	};

	if (sigaltstack(&requested, &previous) < 0) {
		perror("sigaltstack set");
		return 1;
	}
	if (sigaltstack(NULL, &observed) < 0) {
		perror("sigaltstack get");
		return 1;
	}
	if (observed.ss_sp != requested.ss_sp ||
	    observed.ss_size != requested.ss_size ||
	    observed.ss_flags != requested.ss_flags) {
		fprintf(stderr, "sigaltstack native record did not round trip\n");
		return 1;
	}
	if (sigaltstack(&disabled, NULL) < 0) {
		perror("sigaltstack disable");
		return 1;
	}

#if UINTPTR_MAX > UINT32_MAX
	/*
	 * WHY: this state is queried and disabled before any signal can use it.
	 * The deliberately non-dereferenced address proves that the wasm64
	 * host/kernel/glue round trip does not narrow a caller-native stack pointer
	 * merely because the kernel itself is wasm32.
	 */
	requested.ss_sp = (void *)((uintptr_t)UINT32_MAX + 0x2001u);
	requested.ss_size = 4096;
	if (sigaltstack(&requested, NULL) < 0) {
		perror("sigaltstack high wasm64 set");
		return 1;
	}
	if (sigaltstack(NULL, &observed) < 0) {
		perror("sigaltstack high wasm64 get");
		return 1;
	}
	if (observed.ss_sp != requested.ss_sp ||
	    observed.ss_size != requested.ss_size ||
	    observed.ss_flags != requested.ss_flags) {
		fprintf(stderr, "sigaltstack high wasm64 pointer was narrowed\n");
		return 1;
	}
	if (sigaltstack(&disabled, NULL) < 0) {
		perror("sigaltstack high wasm64 disable");
		return 1;
	}
#endif
	return 0;
}

static int test_itimerval_layout(void)
{
	struct itimerval requested;
	struct itimerval previous;
	struct itimerval observed;
	struct itimerval disabled;

	memset(&requested, 0, sizeof(requested));
	requested.it_interval.tv_sec = 2;
	requested.it_value.tv_sec = 5;
	if (setitimer(ITIMER_REAL, &requested, &previous) < 0) {
		perror("setitimer");
		return 1;
	}
	if (getitimer(ITIMER_REAL, &observed) < 0) {
		perror("getitimer");
		return 1;
	}
	if (observed.it_interval.tv_sec != 2 ||
	    observed.it_interval.tv_usec != 0 ||
	    observed.it_value.tv_sec < 0 ||
	    observed.it_value.tv_sec > 5) {
		fprintf(stderr, "itimerval native record did not round trip\n");
		return 1;
	}
	memset(&disabled, 0, sizeof(disabled));
	if (setitimer(ITIMER_REAL, &disabled, NULL) < 0) {
		perror("setitimer disable");
		return 1;
	}
	return 0;
}

static int test_siginfo_layout(void)
{
	sigset_t set;
	sigset_t previous;
	union sigval queued_value;
	struct timespec timeout = { .tv_sec = 1, .tv_nsec = 0 };
	siginfo_t info;
	int received;
	int failed = 0;

	memset(&queued_value, 0, sizeof(queued_value));
#if UINTPTR_MAX > UINT32_MAX
	queued_value.sival_ptr = (void *)(uintptr_t)0x012345678abcdefULL;
#else
	queued_value.sival_int = 0x12345678;
#endif
	sigemptyset(&set);
	sigaddset(&set, SIGUSR1);
	if (sigprocmask(SIG_BLOCK, &set, &previous) < 0) {
		perror("sigprocmask block");
		return 1;
	}
	if (sigqueue(getpid(), SIGUSR1, queued_value) < 0) {
		perror("sigqueue");
		failed = 1;
		goto restore_mask;
	}
	memset(&info, 0xa5, sizeof(info));
	received = sigtimedwait(&set, &info, &timeout);
	if (received < 0) {
		perror("sigtimedwait");
		failed = 1;
		goto restore_mask;
	}
	if (received != SIGUSR1 || info.si_signo != SIGUSR1 ||
	    info.si_code != SI_QUEUE || info.si_pid != getpid()) {
		fprintf(stderr, "siginfo_t native output has wrong fields\n");
		failed = 1;
	}
#if UINTPTR_MAX > UINT32_MAX
	if (info.si_value.sival_ptr != queued_value.sival_ptr) {
		fprintf(stderr, "wasm64 sigqueue pointer value was narrowed\n");
		failed = 1;
	}
#else
	if (info.si_value.sival_int != queued_value.sival_int) {
		fprintf(stderr, "wasm32 sigqueue integer value changed\n");
		failed = 1;
	}
#endif

restore_mask:
	if (sigprocmask(SIG_SETMASK, &previous, NULL) < 0) {
		perror("sigprocmask restore");
		return 1;
	}
	return failed;
}

static int test_siginfo_handler_delivery_layout(void)
{
	struct sigaction action;
	struct sigaction previous_action;
	sigset_t set;
	sigset_t previous_mask;
	union sigval queued_value;
	int failed = 0;

	memset(&action, 0, sizeof(action));
	action.sa_sigaction = queued_siginfo_handler;
	action.sa_flags = SA_SIGINFO;
	sigemptyset(&action.sa_mask);
	if (sigaction(SIGUSR2, &action, &previous_action) < 0) {
		perror("siginfo handler sigaction");
		return 1;
	}

	sigemptyset(&set);
	sigaddset(&set, SIGUSR2);
	if (sigprocmask(SIG_UNBLOCK, &set, &previous_mask) < 0) {
		perror("siginfo handler unblock");
		(void)sigaction(SIGUSR2, &previous_action, NULL);
		return 1;
	}

	memset(&queued_value, 0, sizeof(queued_value));
#if UINTPTR_MAX > UINT32_MAX
	queued_handler_expected_value = (uintptr_t)0x012345678abcdefULL;
	queued_value.sival_ptr = (void *)queued_handler_expected_value;
#else
	queued_handler_expected_value = 0x456789abU;
	queued_value.sival_int = (int)queued_handler_expected_value;
#endif
	queued_handler_expected_pid = getpid();
	queued_handler_seen = 0;
	queued_handler_valid = 0;
	if (sigqueue(queued_handler_expected_pid, SIGUSR2, queued_value) < 0) {
		perror("siginfo handler sigqueue");
		failed = 1;
	} else if (!queued_handler_seen || !queued_handler_valid) {
		fprintf(stderr,
		    "SA_SIGINFO delivery did not preserve the native siginfo record\n");
		failed = 1;
	}

	if (sigprocmask(SIG_SETMASK, &previous_mask, NULL) < 0) {
		perror("siginfo handler restore mask");
		failed = 1;
	}
	if (sigaction(SIGUSR2, &previous_action, NULL) < 0) {
		perror("siginfo handler restore action");
		failed = 1;
	}
	return failed;
}

static int test_posix_timer_sigval_layout(void)
{
	sigset_t set;
	sigset_t previous;
	struct sigevent event;
	struct itimerspec requested;
	struct timespec timeout = { .tv_sec = 2, .tv_nsec = 0 };
	siginfo_t info;
	timer_t timer;
	int received;
	int failed = 0;

	memset(&event, 0, sizeof(event));
	event.sigev_notify = SIGEV_SIGNAL;
	event.sigev_signo = SIGUSR2;
#if UINTPTR_MAX > UINT32_MAX
	event.sigev_value.sival_ptr =
		(void *)(uintptr_t)0x012345678abcdefULL;
#else
	event.sigev_value.sival_int = 0x23456789;
#endif
	sigemptyset(&set);
	sigaddset(&set, SIGUSR2);
	if (sigprocmask(SIG_BLOCK, &set, &previous) < 0) {
		perror("timer sigprocmask block");
		return 1;
	}
	if (timer_create(CLOCK_MONOTONIC, &event, &timer) < 0) {
		perror("timer_create sigval");
		failed = 1;
		goto restore_mask;
	}
	memset(&requested, 0, sizeof(requested));
	requested.it_value.tv_nsec = 1000000;
	if (timer_settime(timer, 0, &requested, NULL) < 0) {
		perror("timer_settime sigval");
		failed = 1;
		goto delete_timer;
	}
	memset(&info, 0xa5, sizeof(info));
	received = sigtimedwait(&set, &info, &timeout);
	if (received < 0) {
		perror("timer sigtimedwait");
		failed = 1;
		goto delete_timer;
	}
	if (received != SIGUSR2 || info.si_signo != SIGUSR2 ||
	    info.si_code != SI_TIMER) {
		fprintf(stderr, "timer siginfo_t has wrong fields\n");
		failed = 1;
	}
#if UINTPTR_MAX > UINT32_MAX
	if (info.si_value.sival_ptr != event.sigev_value.sival_ptr) {
		fprintf(stderr, "wasm64 timer pointer value was narrowed\n");
		failed = 1;
	}
#else
	if (info.si_value.sival_int != event.sigev_value.sival_int) {
		fprintf(stderr, "wasm32 timer integer value changed\n");
		failed = 1;
	}
#endif

delete_timer:
	if (timer_delete(timer) < 0) {
		perror("timer_delete sigval");
		failed = 1;
	}
restore_mask:
	if (sigprocmask(SIG_SETMASK, &previous, NULL) < 0) {
		perror("timer sigprocmask restore");
		return 1;
	}
	return failed;
}

static int test_mqueue_layouts(void)
{
	char name[64];
	struct mq_attr requested;
	struct mq_attr observed;
	struct mq_attr new_attr;
	struct mq_attr old_attr;
	struct sigevent event;
	char empty_message_buffer[64];
	unsigned empty_message_priority = 0;
	ssize_t empty_message_size;
	mqd_t queue;

	snprintf(name, sizeof(name), "/kandelo-native-layout-%ld", (long)getpid());
	(void)mq_unlink(name);
	memset(&requested, 0, sizeof(requested));
	requested.mq_maxmsg = 3;
	requested.mq_msgsize = 64;
	queue = mq_open(name, O_CREAT | O_EXCL | O_RDWR, 0600, &requested);
	if (queue < 0) {
		perror("mq_open");
		return 1;
	}

	memset(&observed, 0xa5, sizeof(observed));
	if (mq_getattr(queue, &observed) < 0) {
		perror("mq_getattr");
		goto fail;
	}
	if (observed.mq_maxmsg != 3 || observed.mq_msgsize != 64 ||
	    observed.mq_curmsgs != 0) {
		fprintf(stderr, "mq_attr native output has wrong fields\n");
		goto fail;
	}

	memset(&new_attr, 0, sizeof(new_attr));
	new_attr.mq_flags = O_NONBLOCK;
	memset(&old_attr, 0xa5, sizeof(old_attr));
	if (mq_setattr(queue, &new_attr, &old_attr) < 0) {
		perror("mq_setattr");
		goto fail;
	}
	if ((old_attr.mq_flags & O_NONBLOCK) != 0 ||
	    old_attr.mq_maxmsg != 3 || old_attr.mq_msgsize != 64) {
		fprintf(stderr, "mq_setattr native old record has wrong fields\n");
		goto fail;
	}

	memset(&event, 0, sizeof(event));
	event.sigev_notify = SIGEV_NONE;
	if (mq_notify(queue, &event) < 0) {
		perror("mq_notify register");
		goto fail;
	}
	if (mq_notify(queue, NULL) < 0) {
		perror("mq_notify unregister");
		goto fail;
	}
	memset(&event, 0, sizeof(event));
	event.sigev_notify = SIGEV_SIGNAL;
	event.sigev_signo = 0;
	errno = 0;
	if (mq_notify(queue, &event) != -1 || errno != EINVAL) {
		fprintf(stderr, "mq_notify accepted signal zero\n");
		goto fail;
	}
	event.sigev_signo = -1;
	errno = 0;
	if (mq_notify(queue, &event) != -1 || errno != EINVAL) {
		fprintf(stderr, "mq_notify accepted a negative signal number\n");
		goto fail;
	}

	/*
	 * WHY: a zero-length POSIX message is valid. The host stages no bytes and
	 * substitutes an allocator-owned empty address without inspecting the
	 * ignored caller pointer. This covers that contract on both caller widths.
	 */
	if (mq_send(queue, "", 0, 7) < 0) {
		perror("mq_send zero length");
		goto fail;
	}
	memset(empty_message_buffer, 0xa5, sizeof(empty_message_buffer));
	empty_message_size = mq_receive(queue, empty_message_buffer,
	    sizeof(empty_message_buffer), &empty_message_priority);
	if (empty_message_size < 0) {
		perror("mq_receive zero length");
		goto fail;
	}
	if (empty_message_size != 0 || empty_message_priority != 7 ||
	    empty_message_buffer[0] != (char)0xa5) {
		fprintf(stderr, "zero-length mqueue message did not round trip\n");
		goto fail;
	}

	if (mq_close(queue) < 0) {
		perror("mq_close");
		(void)mq_unlink(name);
		return 1;
	}
	if (mq_unlink(name) < 0) {
		perror("mq_unlink");
		return 1;
	}
	return 0;

fail:
	(void)mq_close(queue);
	(void)mq_unlink(name);
	return 1;
}

static int test_mqueue_sigval_layout(void)
{
	char name[64];
	struct mq_attr attributes;
	struct sigevent event;
	struct timespec timeout = { .tv_sec = 2, .tv_nsec = 0 };
	sigset_t set;
	sigset_t previous;
	siginfo_t info;
	mqd_t queue = (mqd_t)-1;
	int received;
	int failed = 0;

	snprintf(name, sizeof(name), "/kandelo-mq-sigval-%ld", (long)getpid());
	(void)mq_unlink(name);
	sigemptyset(&set);
	sigaddset(&set, SIGUSR1);
	if (sigprocmask(SIG_BLOCK, &set, &previous) < 0) {
		perror("mq sigprocmask block");
		return 1;
	}

	memset(&attributes, 0, sizeof(attributes));
	attributes.mq_maxmsg = 2;
	attributes.mq_msgsize = 8;
	queue = mq_open(name, O_CREAT | O_EXCL | O_RDWR, 0600, &attributes);
	if (queue < 0) {
		perror("mq sigval open");
		failed = 1;
		goto restore_mask;
	}

	memset(&event, 0, sizeof(event));
	event.sigev_notify = SIGEV_SIGNAL;
	event.sigev_signo = SIGUSR1;
#if UINTPTR_MAX > UINT32_MAX
	event.sigev_value.sival_ptr =
		(void *)(uintptr_t)0x012345678abcdefULL;
#else
	event.sigev_value.sival_int = 0x3456789a;
#endif
	if (mq_notify(queue, &event) < 0) {
		perror("mq sigval notify");
		failed = 1;
		goto close_queue;
	}
	if (mq_send(queue, "x", 1, 0) < 0) {
		perror("mq sigval send");
		failed = 1;
		goto close_queue;
	}

	memset(&info, 0xa5, sizeof(info));
	received = sigtimedwait(&set, &info, &timeout);
	if (received < 0) {
		perror("mq sigtimedwait");
		failed = 1;
		goto close_queue;
	}
	if (received != SIGUSR1 || info.si_signo != SIGUSR1 ||
	    info.si_code != SI_MESGQ || info.si_pid != getpid()) {
		fprintf(stderr, "mqueue siginfo_t has wrong fields\n");
		failed = 1;
	}
#if UINTPTR_MAX > UINT32_MAX
	if (info.si_value.sival_ptr != event.sigev_value.sival_ptr) {
		fprintf(stderr, "wasm64 mqueue pointer value was narrowed\n");
		failed = 1;
	}
#else
	if (info.si_value.sival_int != event.sigev_value.sival_int) {
		fprintf(stderr, "wasm32 mqueue integer value changed\n");
		failed = 1;
	}
#endif

close_queue:
	if (mq_close(queue) < 0) {
		perror("mq sigval close");
		failed = 1;
	}
	if (mq_unlink(name) < 0) {
		perror("mq sigval unlink");
		failed = 1;
	}
restore_mask:
	if (sigprocmask(SIG_SETMASK, &previous, NULL) < 0) {
		perror("mq sigprocmask restore");
		return 1;
	}
	return failed;
}

static int statfs_record_is_valid(const struct statfs *info)
{
	size_t index;

	if (info->f_bsize == 0 || info->f_namelen == 0)
		return 0;
	for (index = 0; index < 4; index++) {
		if (info->f_spare[index] != 0)
			return 0;
	}
	return 1;
}

static int test_statfs_layout(void)
{
	struct statfs path_info;
	struct statfs fd_info;
	int fd;

	memset(&path_info, 0xa5, sizeof(path_info));
	if (statfs("/dev", &path_info) < 0) {
		perror("statfs");
		return 1;
	}
	if (!statfs_record_is_valid(&path_info)) {
		fprintf(stderr, "statfs native output has invalid fields\n");
		return 1;
	}

	fd = open("/dev/null", O_RDONLY);
	if (fd < 0) {
		perror("open /dev/null");
		return 1;
	}
	memset(&fd_info, 0xa5, sizeof(fd_info));
	if (fstatfs(fd, &fd_info) < 0) {
		perror("fstatfs");
		close(fd);
		return 1;
	}
	close(fd);
	if (!statfs_record_is_valid(&fd_info)) {
		fprintf(stderr, "fstatfs native output has invalid fields\n");
		return 1;
	}
	return 0;
}

static int test_sysinfo_layout(void)
{
	struct sysinfo info;
	size_t index;

	memset(&info, 0xa5, sizeof(info));
	if (sysinfo(&info) < 0) {
		perror("sysinfo");
		return 1;
	}
	if (info.uptime != 1 || info.totalram != 512UL * 1024 * 1024 ||
	    info.freeram != 256UL * 1024 * 1024 || info.procs != 1 ||
	    info.mem_unit != 1) {
		fprintf(stderr, "sysinfo native output has invalid fields\n");
		return 1;
	}
	for (index = 0; index < sizeof(info.__reserved); index++) {
		if (info.__reserved[index] != 0) {
			fprintf(stderr, "sysinfo reserved bytes were not zeroed\n");
			return 1;
		}
	}
	return 0;
}

int main(void)
{
	if (test_sigaltstack_layout() ||
	    test_itimerval_layout() ||
	    test_siginfo_layout() ||
	    test_siginfo_handler_delivery_layout() ||
	    test_posix_timer_sigval_layout() ||
	    test_mqueue_layouts() ||
	    test_mqueue_sigval_layout() ||
	    test_statfs_layout() ||
	    test_sysinfo_layout())
		return 1;

	puts("PROCESS NATIVE LAYOUTS PASSED");
	return 0;
}
