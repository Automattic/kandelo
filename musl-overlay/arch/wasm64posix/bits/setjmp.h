/* Wasm setjmp/longjmp buffer — must be large enough to hold
 * struct jmp_buf_impl (func_invocation_id, label, arg).
 * On wasm64, each slot is 8 bytes. */
typedef unsigned long long __jmp_buf[8];
