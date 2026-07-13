#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifdef FILESIZEBITS
#error "FILESIZEBITS must remain undefined when the maximum varies by backend"
#endif

#if _POSIX_ASYNCHRONOUS_IO <= 0
#error "thread-backed asynchronous I/O must remain advertised"
#endif

#if _POSIX_PRIORITIZED_IO != -1
#error "prioritized I/O is not supported"
#endif

#if _POSIX_SYNCHRONIZED_IO != -1
#error "synchronized I/O is not supported"
#endif

static int check(int condition, const char *message)
{
	if (condition) return 0;
	fprintf(stderr, "pathconf failure: %s (errno=%d)\n", message, errno);
	return 1;
}

int main(void)
{
	int failed = 0;
	long value;

	errno = E2BIG;
	value = pathconf("/", _PC_PATH_MAX);
	failed |= check(value == 4096 && errno == E2BIG,
		"finite pathconf result preserves errno");

	errno = E2BIG;
	value = pathconf("/", _PC_LINK_MAX);
	failed |= check(value == -1 && errno == E2BIG,
		"indeterminate pathconf result preserves errno");

	errno = 0;
	value = pathconf("/definitely-missing", _PC_PATH_MAX);
	failed |= check(value == -1 && errno == ENOENT,
		"missing path reports ENOENT");

	errno = 0;
	value = pathconf("/", 999);
	failed |= check(value == -1 && errno == EINVAL,
		"invalid name reports EINVAL");

	errno = 0;
	value = fpathconf(-1, _PC_PATH_MAX);
	failed |= check(value == -1 && errno == EBADF,
		"invalid descriptor reports EBADF");

	const char *path = "/tmp/pathconf-test";
	int fd = open(path, O_CREAT | O_RDWR | O_TRUNC, 0600);
	failed |= check(fd >= 0, "create test file");
	if (fd >= 0) {
		failed |= check(pathconf(path, _PC_ASYNC_IO) > 0,
			"regular pathname reports asynchronous I/O");
		failed |= check(unlink(path) == 0, "unlink open test file");
		errno = E2BIG;
		value = fpathconf(fd, _PC_PATH_MAX);
		failed |= check(value == 4096 && errno == E2BIG,
			"fpathconf uses live descriptor after unlink");
		failed |= check(fpathconf(fd, _PC_ASYNC_IO) > 0,
			"regular descriptor reports asynchronous I/O");
		close(fd);
	}

	unsigned char unaligned_storage[16] = {0};
	long raw = syscall(SYS_pathconf, "/", _PC_PATH_MAX,
		unaligned_storage + 1);
	int64_t raw_value = 0;
	memcpy(&raw_value, unaligned_storage + 1, sizeof(raw_value));
	failed |= check(raw == 0 && raw_value == 4096,
		"unaligned raw output pointer succeeds");

	errno = 0;
	raw = syscall(SYS_pathconf, "/", _PC_PATH_MAX, (void *)0);
	failed |= check(raw == -1 && errno == EFAULT,
		"null raw output pointer reports EFAULT");

	for (uintptr_t remaining = 1; remaining < sizeof(int64_t); remaining++) {
		uintptr_t memory_end =
			(uintptr_t)__builtin_wasm_memory_size(0) * 65536u;
		errno = 0;
		raw = syscall(SYS_pathconf, "/", _PC_PATH_MAX,
			(void *)(memory_end - remaining));
		failed |= check(raw == -1 && errno == EFAULT,
			"out-of-range raw output pointer reports EFAULT");
		failed |= check(getpid() > 0,
			"worker remains live after rejected output pointer");
	}

	if (failed) return 1;
	puts("PATHCONF_PASS");
	return 0;
}
