/*
 * crt_arch.h — Wasm CRT entry point.
 *
 * On real architectures this file contains an __asm__ block that defines
 * the _start symbol (which sets up the stack pointer and calls _start_c).
 *
 * Wasm has no stack-pointer setup concerns. We define _start as a regular
 * C function exported to the host. It calls _start_c (defined in crt1.c)
 * with an argc/argv pointer block.
 *
 * If the host pushed argv via kernel_push_argv before calling _start,
 * we fetch argc/argv from the kernel. Otherwise we fall back to argc=1,
 * argv[0]="a.out".
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

/* Kernel imports for argv support */
__attribute__((import_module("kernel"), import_name("kernel_get_argc")))
unsigned kernel_get_argc(void);
__attribute__((import_module("kernel"), import_name("kernel_argv_read")))
unsigned kernel_argv_read(unsigned index, unsigned char *buf, unsigned buf_max);

__attribute__((export_name("_start")))
void _start(void)
{
    /*
     * _start_c expects a pointer p where:
     *   p[0] = argc
     *   p[1..argc] = argv pointers
     *   p[argc+1] = NULL (end of argv)
     *   p[argc+2] = NULL (end of envp)
     *   p[argc+3] = 0 (AT_NULL auxv key)
     *   p[argc+4] = 0 (AT_NULL auxv value)
     */
    unsigned argc = kernel_get_argc();

    if (argc == 0) {
        /* No args set by host — default to "a.out" */
        static char prog_name[] = "a.out";
        long start_data[6];
        start_data[0] = 1;
        start_data[1] = (long)prog_name;
        start_data[2] = 0;
        start_data[3] = 0;
        start_data[4] = 0;
        start_data[5] = 0;
        _start_c(start_data);
        return;
    }

    /* Fetch argv strings from kernel into static buffers */
    #define MAX_ARGC 256
    #define ARGV_BUF_SIZE 8192
    static char argv_buf[ARGV_BUF_SIZE];
    static long start_data[MAX_ARGC + 5]; /* argc + argv ptrs + NULL + envp NULL + auxv */

    if (argc > MAX_ARGC) argc = MAX_ARGC;

    unsigned offset = 0;
    unsigned i;
    for (i = 0; i < argc && offset < ARGV_BUF_SIZE - 1; i++) {
        unsigned len = kernel_argv_read(i, (unsigned char *)&argv_buf[offset],
                                        ARGV_BUF_SIZE - offset - 1);
        argv_buf[offset + len] = '\0';
        start_data[1 + i] = (long)&argv_buf[offset];
        offset += len + 1;
    }
    argc = i; /* actual count after possible truncation */

    start_data[0] = argc;
    start_data[1 + argc] = 0;     /* argv NULL terminator */
    start_data[2 + argc] = 0;     /* envp NULL terminator */
    start_data[3 + argc] = 0;     /* auxv AT_NULL */
    start_data[4 + argc] = 0;     /* auxv value */

    _start_c(start_data);
}
#endif /* !SHARED */
