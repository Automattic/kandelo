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

void __init_libc(char **envp, char *pn)
{
	__environ = envp;

	/* On Wasm, there is no auxv, TLS, or secure-execution mode.
	 * Set up minimal libc state only. */
	libc.page_size = 65536; /* Wasm page size */

	if (!pn) pn = "";
	__progname = __progname_full = pn;

	/* Initialize the thread pointer.  On real architectures this is
	 * done by __init_tls -> __init_tp, but Wasm has no TLS segments.
	 * We must at least set td->self and td->locale so that
	 * CURRENT_UTF8 / CURRENT_LOCALE (which dereference td->locale)
	 * don't crash with a null-pointer read. */
	pthread_t td = __pthread_self();
	td->self = td;
	td->locale = &libc.global_locale;
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

static int libc_start_main_stage2(int (*main)(int,char **), int argc, char **argv)
{
	__libc_start_init();

	/* Call main and exit. */
	exit(main(argc, argv));
}
