/*
 * crt1.c — Wasm-specific CRT entry point.
 *
 * This replaces musl's standard crt1.c for the wasm32posix target.
 *
 * Clang for wasm32 lowers main depending on its signature:
 *   int main(int, char **) => __main_argc_argv
 *   int main(void)         => __main_void
 *   int main(int, char **, char **) => main
 *
 * We always call the libc entry adapter here. It picks the available
 * program entry shape after libc has initialized environ.
 */

#include <features.h>
#include "libc.h"

#define START "_start"

#include "crt_arch.h"

int __wasm_posix_main(int, char **);

weak void _init();
weak void _fini();
int __libc_start_main(int (*)(int, char **), int, char **,
	void (*)(), void(*)(), void(*)());

void _start_c(long *p)
{
	int argc = p[0];
	char **argv = (void *)(p+1);
	__libc_start_main(__wasm_posix_main, argc, argv, _init, _fini, 0);
}
