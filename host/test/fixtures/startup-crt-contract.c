#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>

static jmp_buf failure_jump;
static _Noreturn void test_trap(void);

#define _start test_start
#define _start_c test_start_c
#define __libc_start_main test_libc_start_main
#define __main_argc_argv test_main_argc_argv
#define _init test_init
#define _fini test_fini
#define kernel_get_argc test_kernel_get_argc
#define kernel_argv_read test_kernel_argv_read
#define kernel_environ_count test_kernel_environ_count
#define kernel_environ_get test_kernel_environ_get
#define mmap test_mmap
#define __builtin_trap() test_trap()

void *test_mmap(void *, size_t, int, int, int, off_t);

#include "../../../libc/musl-overlay/crt/crt1.c"

static const char *test_argv[] = { "program", "argument" };
static const char *test_env[] = { "FIRST=value", "SECOND=value" };
static unsigned test_argc;
static unsigned test_envc;
static int fail_allocation;
static int mismatch_copy;
static int published;
static void *last_mapping;
static size_t last_mapping_bytes;

static _Noreturn void test_trap(void)
{
	longjmp(failure_jump, 1);
}

int test_kernel_get_argc(void)
{
	return (int)test_argc;
}

int test_kernel_environ_count(void)
{
	return (int)test_envc;
}

static int read_entry(
	const char *const *entries,
	unsigned count,
	unsigned index,
	unsigned char *buffer,
	unsigned capacity)
{
	if (index >= count) return -22;
	size_t length = strlen(entries[index]);
	if (!capacity) return (int)length;
	if (capacity < length) return -34;
	if (mismatch_copy && index == 0) return (int)length - 1;
	memcpy(buffer, entries[index], length);
	return (int)length;
}

int test_kernel_argv_read(
	unsigned index,
	unsigned char *buffer,
	unsigned capacity)
{
	return read_entry(test_argv, test_argc, index, buffer, capacity);
}

int test_kernel_environ_get(
	unsigned index,
	unsigned char *buffer,
	unsigned capacity)
{
	return read_entry(test_env, test_envc, index, buffer, capacity);
}

void *test_mmap(
	void *address,
	size_t length,
	int protection,
	int flags,
	int fd,
	off_t offset)
{
	(void)address;
	(void)protection;
	(void)flags;
	(void)fd;
	(void)offset;
	if (fail_allocation) return MAP_FAILED;
	last_mapping = calloc(1, length);
	last_mapping_bytes = length;
	return last_mapping ? last_mapping : MAP_FAILED;
}

int test_main_argc_argv(int argc, char **argv)
{
	(void)argc;
	(void)argv;
	return 0;
}

void test_init(void) {}
void test_fini(void) {}

int test_libc_start_main(
	int (*main_function)(int, char **),
	int argc,
	char **argv,
	void (*init_function)(void),
	void (*fini_function)(void),
	void (*loader_fini)(void))
{
	(void)main_function;
	(void)init_function;
	(void)fini_function;
	(void)loader_fini;
	published = 1;
	if ((unsigned)argc != test_argc) return 91;
	for (unsigned i = 0; i < test_argc; i++)
		if (strcmp(argv[i], test_argv[i])) return 92;
	if (argv[test_argc]) return 93;
	char **env = argv + test_argc + 1;
	for (unsigned i = 0; i < test_envc; i++)
		if (strcmp(env[i], test_env[i])) return 94;
	if (env[test_envc]) return 95;
	return 0;
}

static int run_expect_success(void)
{
	test_argc = 2;
	test_envc = 2;
	fail_allocation = 0;
	mismatch_copy = 0;
	published = 0;
	last_mapping = 0;
	last_mapping_bytes = 0;
	if (setjmp(failure_jump)) return 1;
	test_start();
	if (!published || !last_mapping || last_mapping_bytes >= 4096) return 2;
	free(last_mapping);
	return 0;
}

static int run_expect_allocation_failure(void)
{
	test_argc = 1;
	test_envc = 0;
	fail_allocation = 1;
	mismatch_copy = 0;
	published = 0;
	if (!setjmp(failure_jump)) {
		test_start();
		return 3;
	}
	return published ? 4 : 0;
}

static int run_expect_retry_mismatch(void)
{
	test_argc = 1;
	test_envc = 0;
	fail_allocation = 0;
	mismatch_copy = 1;
	published = 0;
	last_mapping = 0;
	if (!setjmp(failure_jump)) {
		test_start();
		return 5;
	}
	free(last_mapping);
	return published ? 6 : 0;
}

int main(void)
{
	int result = run_expect_success();
	if (!result) result = run_expect_allocation_failure();
	if (!result) result = run_expect_retry_mismatch();
	if (result) {
		fprintf(stderr, "startup-crt-contract failure %d\n", result);
		return result;
	}
	puts("startup-crt-contract: ok");
	return 0;
}
