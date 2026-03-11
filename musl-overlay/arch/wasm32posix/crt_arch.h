/*
 * crt_arch.h — Wasm CRT entry point.
 *
 * On real architectures this file contains an __asm__ block that defines
 * the _start symbol (which sets up the stack pointer and calls _start_c).
 *
 * Wasm has no stack-pointer setup concerns. We define _start as a regular
 * C function exported to the host. It calls _start_c (defined in crt1.c)
 * with an argc/argv pointer block containing argc=1 and argv[0]="a.out",
 * since Wasm modules don't receive command-line arguments via the stack.
 *
 * The SHARED guard prevents this from conflicting with ldso/dlstart.c
 * which also includes crt_arch.h but defines its own _start_c variant.
 */
#define START "_start"

#ifndef SHARED
/*
 * _start_c is defined in crt1.c after this header is included.
 * The __asm__ block normally references it by name; we forward-declare
 * it so our C _start can call it.
 */
void _start_c(long *);

__attribute__((export_name("_start")))
void _start(void)
{
    /* Build a minimal argc/argv/envp/auxv block:
     *   p[0] = argc = 1
     *   p[1] = argv[0] = "a.out"  (program name)
     *   p[2] = argv[1] = NULL     (end of argv)
     *   p[3] = envp[0] = NULL     (end of envp)
     *   p[4] = auxv[0] = 0        (end of auxv — AT_NULL terminator)
     *   p[5] = 0                  (auxv value for AT_NULL)
     *
     * _start_c expects:  argc = p[0], argv = (void *)(p+1)
     * __init_libc then computes:
     *   envp = argv + argc + 1 = &p[3]
     *   auxv = envp + 0 + 1    = &p[4]
     * The auxv loop reads pairs until it finds AT_NULL (0).
     *
     * We construct start_data at runtime because the pointer to prog_name
     * is not a compile-time constant suitable for a static array initializer.
     */
    static char prog_name[] = "a.out";
    long start_data[6];
    start_data[0] = 1;                    /* argc */
    start_data[1] = (long)prog_name;      /* argv[0] */
    start_data[2] = 0;                    /* argv[1] = NULL (end of argv) */
    start_data[3] = 0;                    /* envp[0] = NULL (end of envp) */
    start_data[4] = 0;                    /* auxv AT_NULL */
    start_data[5] = 0;                    /* auxv value */
    _start_c(start_data);
}
#endif /* !SHARED */
