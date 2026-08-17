/*
 * Wasm setjmp/longjmp runtime — provides the helper functions called
 * by LLVM's WebAssemblyLowerEmscriptenEHSjLj pass.
 *
 * Based on wasi-libc implementation:
 * https://github.com/WebAssembly/wasi-libc/blob/main/libc-top-half/libc/musl/src/setjmp/wasm32/rt.c
 *
 * Reference:
 *   https://github.com/llvm/llvm-project/pull/84137
 *   https://docs.google.com/document/d/1ZvTPT36K5jjiedF8MCXbEmYjULJjI723aOAks1IdLLg/edit
 */

#include <stddef.h>
#include <stdint.h>
#include <setjmp.h>

/*
 * function prototypes
 */
void __wasm_setjmp(void *env, uint32_t label, void *func_invocation_id);
uint32_t __wasm_setjmp_test(void *env, void *func_invocation_id);
void __wasm_longjmp(void *env, int val);
unsigned long __wasm_posix_caught_handler_depth(void);
void __wasm_posix_longjmp_cleanup(unsigned long target_depth);

/*
 * jmp_buf should have large enough size and alignment to contain
 * this structure.
 */
struct jmp_buf_impl {
	void *func_invocation_id;
	uint32_t label;

	/*
	 * This is a temporary storage used by the communication between
	 * __wasm_longjmp and WebAssemblyLowerEmscriptenEHSjLj-generated
	 * logic.
	 * Ideally, this can be replaced with multivalue.
	 */
	struct arg {
		void *env;
		int val;
	} arg;

	/* Target caught-handler depth for generic and signal-aware longjmp.
	 * This stays inside the existing architecture jmp_buf storage. */
	unsigned long handler_depth;
};

_Static_assert(sizeof(struct jmp_buf_impl) <= sizeof(__jmp_buf),
	"Wasm setjmp runtime exceeds architecture jmp_buf storage");

void
__wasm_setjmp(void *env, uint32_t label, void *func_invocation_id)
{
	struct jmp_buf_impl *jb = env;
	if (label == 0) { /* ABI contract */
		__builtin_trap();
	}
	if (func_invocation_id == NULL) { /* sanity check */
		__builtin_trap();
	}
	jb->func_invocation_id = func_invocation_id;
	jb->label = label;
	jb->handler_depth = __wasm_posix_caught_handler_depth();
}

uint32_t
__wasm_setjmp_test(void *env, void *func_invocation_id)
{
	struct jmp_buf_impl *jb = env;
	if (jb->label == 0) { /* ABI contract */
		__builtin_trap();
	}
	if (func_invocation_id == NULL) { /* sanity check */
		__builtin_trap();
	}
	if (jb->func_invocation_id == func_invocation_id) {
		return jb->label;
	}
	return 0;
}

void
__wasm_longjmp(void *env, int val)
{
	struct jmp_buf_impl *jb = env;
	struct arg *arg = &jb->arg;
	__wasm_posix_longjmp_cleanup(jb->handler_depth);
	/*
	 * C standard says:
	 * The longjmp function cannot cause the setjmp macro to return
	 * the value 0; if val is 0, the setjmp macro returns the value 1.
	 */
	if (val == 0) {
		val = 1;
	}
	arg->env = env;
	arg->val = val;
	__builtin_wasm_throw(1, arg); /* 1 == C_LONGJMP */
}
