/*
 * __libc_start_main.c — Wasm-specific replacement for musl's version.
 *
 * On Wasm, clang generates `main` with signature (int, char**) -> int.
 * Standard musl calls main(argc, argv, envp) — 3 args — which causes
 * a Wasm call_indirect type mismatch. This version uses 2 args.
 *
 * The Wasm-specific __init_libc lives in a separate object so Go-led
 * processes can initialize libc without also linking the C process entry.
 */

#include <stdlib.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include "syscall.h"
#include "atomic.h"
#include "libc.h"
#include "pthread_impl.h"

static void dummy(void) {}
weak_alias(dummy, _init);

extern weak hidden void (*const __init_array_start)(void), (*const __init_array_end)(void);

static void dummy1(void *p) {}
weak_alias(dummy1, __init_ssp);

void __init_libc(char **envp, char *pn);

static void libc_start_init(void)
{
	/* Kandelo links process modules in reactor mode while retaining the
	 * exported _start entry. This leaves constructor ownership here, after
	 * __init_libc has installed environment and secure-startup state. */
	extern void __wasm_call_ctors(void);
	__wasm_call_ctors();
}

weak_alias(libc_start_init, __libc_start_init);

int __main_argc_argv(int, char **);

/* WHY noinline and a direct call: upstream musl calls stage 2 through a
 * pointer laundered by an asm statement, a barrier against hoisting
 * application code or initializers above __init_libc. On Wasm that pointer
 * puts stage 2 in the indirect function table, and fork instrumentation must
 * then assume any indirect call of its type may re-enter main (see crt1.c).
 * noinline keeps stage 2 a separate body and the memory clobber keeps memory
 * accesses on their side of the call, which is the same barrier. */
static int libc_start_main_stage2(int (*)(int,char **), int, char **)
	__attribute__((noinline));

int __libc_start_main(int (*main)(int,char **), int argc, char **argv,
	void (*init_dummy)(), void(*fini_dummy)(), void(*ldso_dummy)())
{
	char **envp = argv+argc+1;

	__init_libc(envp, argv[0]);

	__asm__ ( "" : : : "memory" );
	return libc_start_main_stage2(main, argc, argv);
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

	/* Call main and exit. A direct call, not through the pointer crt1 used
	 * to pass: keeping main out of the indirect function table lets fork
	 * instrumentation see that main is entered only from here (see crt1.c).
	 * A non-null pointer (a foreign start routine) is still honoured. */
	if (main)
		exit(main(argc, argv));
	exit(__main_argc_argv(argc, argv));
}
