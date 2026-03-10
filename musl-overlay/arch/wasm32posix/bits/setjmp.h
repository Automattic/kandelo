/* Wasm setjmp/longjmp buffer. We don't really support these yet,
 * but the type must be defined for musl to compile. */
typedef unsigned long __jmp_buf[6];
