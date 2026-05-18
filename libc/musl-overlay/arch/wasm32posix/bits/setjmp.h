/* Wasm setjmp/longjmp buffer — must be large enough to hold
 * struct jmp_buf_impl (func_invocation_id, label, arg). */
typedef unsigned long __jmp_buf[8];
