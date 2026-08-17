/*
 * sigsetjmp/siglongjmp helpers for wasm32.
 *
 * LLVM's SjLj pass only recognizes calls to functions literally named
 * "setjmp" and "longjmp". We therefore make sigsetjmp/siglongjmp into
 * macros that call these helpers and then call setjmp/longjmp.
 *
 * sigsetjmp(buf, savemask) expands to:
 *     (__sigsetjmp_save(buf, savemask), setjmp(buf))
 *
 * siglongjmp(buf, val) expands to:
 *     (__siglongjmp_restore(buf), longjmp(buf, val))
 */

#include <signal.h>
#include <string.h>

/* These reference the __fl and __ss fields of struct __jmp_buf_tag
 * defined in musl's include/setjmp.h. sigjmp_buf is typedef'd as
 * jmp_buf which is struct __jmp_buf_tag[1], so buf->__fl etc works. */

void __sigsetjmp_save(void *buf_raw, int savemask)
{
	/* Cast through the actual struct type. sigjmp_buf is jmp_buf
	 * which is struct __jmp_buf_tag[1]. We receive void* from the
	 * macro to avoid header ordering issues. */
	struct __jmp_buf_tag {
		unsigned long __jb[8];
		unsigned long __fl;
		unsigned long __ss[128/sizeof(unsigned long)];
	} *buf = buf_raw;

	if (savemask) {
		sigprocmask(SIG_BLOCK, 0, (sigset_t *)buf->__ss);
		buf->__fl = 1;
	} else {
		buf->__fl = 0;
	}
}

void __siglongjmp_restore(void *buf_raw)
{
	struct __jmp_buf_tag {
		unsigned long __jb[8];
		unsigned long __fl;
		unsigned long __ss[128/sizeof(unsigned long)];
	} *buf = buf_raw;

	if (buf->__fl) {
		sigprocmask(SIG_SETMASK, (const sigset_t *)buf->__ss, 0);
	}
}

