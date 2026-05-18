/* Arch-specific siglongjmp for wasm32posix.
 * Restores signal mask saved by sigsetjmp, then calls longjmp.
 * Replaces musl's default siglongjmp.c which doesn't restore
 * the mask (musl's default relies on assembly sigsetjmp/longjmp
 * that we don't use on wasm32). */
#include <setjmp.h>

/* Undo the macro so we can define the real function */
#undef siglongjmp

extern void __siglongjmp_restore(void *);

_Noreturn void siglongjmp(sigjmp_buf buf, int val)
{
	__siglongjmp_restore(buf);
	longjmp(buf, val);
}
