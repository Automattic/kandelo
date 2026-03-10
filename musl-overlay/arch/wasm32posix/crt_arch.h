/*
 * crt_arch.h — Wasm CRT entry point.
 *
 * On real architectures this file contains an __asm__ block that defines
 * the _start symbol (which sets up the stack pointer and calls _start_c).
 *
 * Wasm has no stack-pointer setup concerns. We define _start as a regular
 * C function exported to the host. It calls _start_c (defined in crt1.c)
 * with a fake argc/argv pointer block since Wasm modules don't receive
 * command-line arguments via the stack.
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
    /* Build a minimal argc/argv block:
     *   p[0] = argc = 0
     *   p[1] = argv[0] = NULL  (end of argv)
     *   p[2] = NULL             (end of envp)
     *
     * _start_c expects:  argc = p[0], argv = (void *)(p+1)
     */
    static long start_data[] = { 0, 0, 0 };
    _start_c(start_data);
}
#endif /* !SHARED */
