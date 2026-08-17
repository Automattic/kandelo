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
