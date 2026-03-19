/*
 * __libc_start_main.c — Wasm-specific replacement for musl's version.
 *
 * On Wasm, clang generates `main` with signature (int, char**) -> int.
 * Standard musl calls main(argc, argv, envp) — 3 args — which causes
 * a Wasm call_indirect type mismatch. This version uses 2 args.
 *
 * Additionally, the standard __init_libc is replaced with a simplified
 * version for Wasm that avoids iterating auxv (not available on Wasm)
 * and avoids TLS init (single-threaded).
 */

#include <stdlib.h>
#include <unistd.h>
#include "syscall.h"
#include "atomic.h"
#include "libc.h"
#include "pthread_impl.h"

static void dummy(void) {}
weak_alias(dummy, _init);

extern weak hidden void (*const __init_array_start)(void), (*const __init_array_end)(void);

static void dummy1(void *p) {}
weak_alias(dummy1, __init_ssp);

extern unsigned long __wasm_tp_storage[64];
extern unsigned long __wasm_thread_pointer;
int __init_tp(void *);

void __init_libc(char **envp, char *pn)
{
	__environ = envp;

	/* On Wasm, there is no auxv, TLS, or secure-execution mode.
	 * Set up minimal libc state only. */
	libc.page_size = 65536; /* Wasm page size */

	if (!pn) pn = "";
	__progname = __progname_full = pn;

	/* Initialize the thread pointer for the main thread.
	 * Set __wasm_thread_pointer to point at __wasm_tp_storage,
	 * then call __init_tp which sets self, locale, tid,
	 * libc.can_do_threads, etc. */
	__wasm_thread_pointer = (unsigned long)__wasm_tp_storage;
	__init_tp((void *)__wasm_tp_storage);
}

static void libc_start_init(void)
{
	_init();
	uintptr_t a = (uintptr_t)&__init_array_start;
	for (; a<(uintptr_t)&__init_array_end; a+=sizeof(void(*)()))
		(*(void (**)(void))a)();
}

weak_alias(libc_start_init, __libc_start_init);

typedef int lsm2_fn(int (*)(int,char **), int, char **);
static lsm2_fn libc_start_main_stage2;

int __libc_start_main(int (*main)(int,char **), int argc, char **argv,
	void (*init_dummy)(), void(*fini_dummy)(), void(*ldso_dummy)())
{
	char **envp = argv+argc+1;

	__init_libc(envp, argv[0]);

	lsm2_fn *stage2 = libc_start_main_stage2;
	__asm__ ( "" : "+r"(stage2) : : "memory" );
	return stage2(main, argc, argv);
}

/* Kernel imports for fork child detection */
extern int32_t kernel_is_fork_child(void)
	__attribute__((import_module("kernel"), import_name("kernel_is_fork_child")));
extern int32_t kernel_apply_fork_fd_actions(void)
	__attribute__((import_module("kernel"), import_name("kernel_apply_fork_fd_actions")));
extern int32_t kernel_get_fork_exec_path(uint8_t *, uint32_t)
	__attribute__((import_module("kernel"), import_name("kernel_get_fork_exec_path")));
extern int32_t kernel_get_fork_exec_argc(void)
	__attribute__((import_module("kernel"), import_name("kernel_get_fork_exec_argc")));
extern int32_t kernel_get_fork_exec_argv(uint32_t, uint8_t *, uint32_t)
	__attribute__((import_module("kernel"), import_name("kernel_get_fork_exec_argv")));
extern int32_t kernel_clear_fork_exec(void)
	__attribute__((import_module("kernel"), import_name("kernel_clear_fork_exec")));
extern int32_t kernel_execve(const uint8_t *, uint32_t)
	__attribute__((import_module("kernel"), import_name("kernel_execve")));
extern _Noreturn void kernel_exit(int32_t)
	__attribute__((import_module("kernel"), import_name("kernel_exit")));

static _Noreturn void fork_child_exec(void)
{
	/* Apply saved fd actions (dup2, close) */
	kernel_apply_fork_fd_actions();

	/* Read saved exec path */
	uint8_t path_buf[4096];
	int32_t path_len = kernel_get_fork_exec_path(path_buf, sizeof(path_buf));
	if (path_len <= 0) {
		/* No exec path saved — exit with error */
		kernel_exit(127);
	}

	/* Push argv for the new program (handled by kernel during exec) */
	int32_t exec_argc = kernel_get_fork_exec_argc();
	if (exec_argc > 0) {
		/* The kernel will carry argv across exec via the serialized state */
		uint8_t arg_buf[4096];
		for (int32_t i = 0; i < exec_argc; i++) {
			int32_t arg_len = kernel_get_fork_exec_argv(i, arg_buf, sizeof(arg_buf));
			if (arg_len > 0) {
				extern void kernel_push_argv(const uint8_t *, uint32_t)
					__attribute__((import_module("kernel"), import_name("kernel_push_argv")));
				kernel_push_argv(arg_buf, arg_len);
			}
		}
	}

	/* Clear fork state before exec */
	kernel_clear_fork_exec();

	/* Call execve via kernel — this will replace the current program */
	int32_t ret = kernel_execve(path_buf, path_len);
	/* If exec fails, exit */
	(void)ret;
	kernel_exit(127);
}

static int libc_start_main_stage2(int (*main)(int,char **), int argc, char **argv)
{
	/* Check if we are a fork child that should exec instead of running main */
	if (kernel_is_fork_child()) {
		fork_child_exec();
		/* Not reached */
	}

	__libc_start_init();

	/* Call main and exit. */
	exit(main(argc, argv));
}
