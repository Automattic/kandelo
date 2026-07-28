/*
 * crt1.c — Wasm-specific CRT entry point.
 *
 * This replaces musl's standard crt1.c for the wasm32posix target.
 *
 * Clang for wasm32 mangles main depending on its signature:
 *   int main(int, char **) => __main_argc_argv
 *   int main(void)         => __main_void
 *
 * We always call __main_argc_argv here. For programs that define
 * main(void), a weak fallback in __main_void.c bridges the gap
 * by forwarding __main_argc_argv -> __main_void.
 */

#include <features.h>
#include <stdint.h>
#include <sys/mman.h>
#include <bits/kandelo_limits.h>
#include "libc.h"

#define START "_start"

#include "crt_arch.h"

int __main_argc_argv(int, char **);

weak void _init();
weak void _fini();
int __libc_start_main(int (*)(int, char **), int, char **,
	void (*)(), void(*)(), void(*)());

void _start_c(long *p)
{
	int argc = p[0];
	char **argv = (void *)(p+1);
	__libc_start_main(__main_argc_argv, argc, argv, _init, _fini, 0);
}

__attribute__((import_module("kernel"), import_name("kernel_get_argc")))
int kernel_get_argc(void);
__attribute__((import_module("kernel"), import_name("kernel_argv_read")))
int kernel_argv_read(unsigned, unsigned char *, unsigned);
__attribute__((import_module("kernel"), import_name("kernel_environ_count")))
int kernel_environ_count(void);
__attribute__((import_module("kernel"), import_name("kernel_environ_get")))
int kernel_environ_get(unsigned, unsigned char *, unsigned);

/*
 * Query results are retained across the allocation boundary. This is small,
 * fixed metadata (32 KiB at the generated count maxima), not a destination
 * for variable strings.
 *
 * WHY: querying again after mmap would create a time-of-check/time-of-use gap.
 * Keeping every exact length lets the copy return ERANGE or a mismatched count
 * if launch metadata changes, before _start_c publishes any argv/env pointers.
 */
static uint32_t startup_entry_lengths[
	KANDELO_PROCESS_STARTUP_MAX_ARGV_COUNT
	+ KANDELO_PROCESS_STARTUP_MAX_ENVP_COUNT
];

static _Noreturn void startup_contract_failure(void)
{
	/* No libc state has been published yet. A trap is the only truthful
	 * failure at this boundary; continuing would launch with partial metadata. */
	__builtin_trap();
}

static void add_startup_entry_length(
	size_t *string_bytes,
	unsigned length_index,
	int length)
{
	if (length < 0
	    || (unsigned)length > KANDELO_PROCESS_METADATA_ENTRY_MAX_BYTES
	    || (size_t)length + 1 > KANDELO_POSIX_ARG_MAX_BYTES - *string_bytes)
		startup_contract_failure();
	startup_entry_lengths[length_index] = (uint32_t)length;
	*string_bytes += (size_t)length + 1;
}

__attribute__((export_name("_start")))
void _start(void)
{
	/*
	 * LLVM initializes main-thread TLS before this exported entry runs. The
	 * syscall channel is also live, so an ordinary anonymous mmap can own the
	 * exact argv/env table for the complete libc lifetime.
	 */
	int raw_argc = kernel_get_argc();
	int raw_envc = kernel_environ_count();
	if (raw_argc < 0
	    || (unsigned)raw_argc > KANDELO_PROCESS_STARTUP_MAX_ARGV_COUNT
	    || raw_envc < 0
	    || (unsigned)raw_envc > KANDELO_PROCESS_STARTUP_MAX_ENVP_COUNT)
		startup_contract_failure();

	unsigned argc = (unsigned)raw_argc;
	unsigned envc = (unsigned)raw_envc;
	size_t pointer_entries = (size_t)argc + envc + 2;
	if (pointer_entries > SIZE_MAX / sizeof(char *))
		startup_contract_failure();
	size_t represented_bytes = pointer_entries * sizeof(char *);
	if (represented_bytes > KANDELO_POSIX_ARG_MAX_BYTES)
		startup_contract_failure();

	size_t string_bytes = 0;
	unsigned i;
	for (i = 0; i < argc; i++) {
		int length = kernel_argv_read(i, 0, 0);
		add_startup_entry_length(&string_bytes, i, length);
	}
	for (i = 0; i < envc; i++) {
		int length = kernel_environ_get(i, 0, 0);
		add_startup_entry_length(&string_bytes, argc + i, length);
	}
	if (string_bytes > KANDELO_POSIX_ARG_MAX_BYTES - represented_bytes)
		startup_contract_failure();

	/*
	 * Preserve the historical empty-argv fallback without charging its static
	 * "a.out" bytes to caller-provided ARG_MAX metadata.
	 */
	unsigned startup_argc = argc ? argc : 1;
	size_t start_words = (size_t)startup_argc + envc + 5;
	if (start_words > SIZE_MAX / sizeof(long))
		startup_contract_failure();
	size_t start_bytes = start_words * sizeof(long);
	if (string_bytes > SIZE_MAX - start_bytes)
		startup_contract_failure();
	size_t mapping_bytes = start_bytes + string_bytes;

	long *start_data = mmap(
		0,
		mapping_bytes,
		PROT_READ | PROT_WRITE,
		MAP_PRIVATE | MAP_ANONYMOUS,
		-1,
		0);
	if (start_data == MAP_FAILED)
		startup_contract_failure();
	unsigned char *strings = (unsigned char *)start_data + start_bytes;
	size_t cursor = 0;

	if (!argc) {
		static char prog_name[] = "a.out";
		start_data[1] = (long)prog_name;
	} else {
		for (i = 0; i < argc; i++) {
			uint32_t capacity = startup_entry_lengths[i];
			if (cursor > string_bytes
			    || (size_t)capacity + 1 > string_bytes - cursor)
				startup_contract_failure();
			int copied = kernel_argv_read(i, strings + cursor, capacity);
			if (copied < 0 || (uint32_t)copied != capacity)
				startup_contract_failure();
			strings[cursor + capacity] = 0;
			start_data[1 + i] = (long)(strings + cursor);
			cursor += (size_t)capacity + 1;
		}
	}

	start_data[0] = startup_argc;
	start_data[1 + startup_argc] = 0;
	for (i = 0; i < envc; i++) {
		uint32_t capacity = startup_entry_lengths[argc + i];
		if (cursor > string_bytes
		    || (size_t)capacity + 1 > string_bytes - cursor)
			startup_contract_failure();
		int copied = kernel_environ_get(i, strings + cursor, capacity);
		if (copied < 0 || (uint32_t)copied != capacity)
			startup_contract_failure();
		strings[cursor + capacity] = 0;
		start_data[2 + startup_argc + i] = (long)(strings + cursor);
		cursor += (size_t)capacity + 1;
	}
	if (cursor != string_bytes)
		startup_contract_failure();

	start_data[2 + startup_argc + envc] = 0;
	start_data[3 + startup_argc + envc] = 0;
	start_data[4 + startup_argc + envc] = 0;
	_start_c(start_data);
}
