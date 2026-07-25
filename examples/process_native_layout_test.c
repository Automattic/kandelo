#define _GNU_SOURCE

#include <fcntl.h>
#include <mqueue.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/statfs.h>
#include <sys/sysinfo.h>
#include <sys/time.h>
#include <unistd.h>

static unsigned char alternate_stack[SIGSTKSZ];

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
	    test_mqueue_layouts() ||
	    test_statfs_layout() ||
	    test_sysinfo_layout())
		return 1;

	puts("PROCESS NATIVE LAYOUTS PASSED");
	return 0;
}
