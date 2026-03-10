/*
 * crt1.c — Wasm-specific CRT entry point.
 *
 * This replaces musl's standard crt1.c for the wasm32posix target.
 *
 * Key difference: main is declared as int main(int, char**) rather than
 * int main(). On Wasm, clang treats int main() as int main(void) and
 * generates a reference to __original_main (type () -> i32). But
 * __libc_start_main calls main via call_indirect with a typed function
 * pointer, causing a signature mismatch trap.
 *
 * By declaring main(int, char**), clang generates a properly-typed
 * reference that matches the call_indirect in __libc_start_main.
 */

#include <features.h>
#include "libc.h"

#define START "_start"

#include "crt_arch.h"

/* Declare main with explicit 2-arg prototype to prevent clang from
 * generating __original_main / __main_void references. */
int main(int, char **);

weak void _init();
weak void _fini();
int __libc_start_main(int (*)(int, char **), int, char **,
	void (*)(), void(*)(), void(*)());

void _start_c(long *p)
{
	int argc = p[0];
	char **argv = (void *)(p+1);
	__libc_start_main(main, argc, argv, _init, _fini, 0);
}
