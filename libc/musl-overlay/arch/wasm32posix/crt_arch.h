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
 * Environment variables are populated from the kernel's proc.environ via
 * kernel_environ_count / kernel_environ_get so that getenv() works and
 * __environ reflects the host-set environment.
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

/* Kernel imports for environ support */
__attribute__((import_module("kernel"), import_name("kernel_environ_count")))
unsigned kernel_environ_count(void);
__attribute__((import_module("kernel"), import_name("kernel_environ_get")))
int kernel_environ_get(unsigned index, unsigned char *buf, unsigned buf_max);

__attribute__((export_name("_start")))
void _start(void)
{
    /* Note: LLVM TLS for the main thread is initialized by the Wasm
     * module's start function (__wasm_init_memory), which runs before
     * _start. Do NOT call __wasm_init_tls here — the passive data
     * segments have already been dropped by that point. */

    /*
     * _start_c expects a pointer p where:
     *   p[0] = argc
     *   p[1..argc] = argv pointers
     *   p[argc+1] = NULL (end of argv)
     *   p[argc+2..argc+1+envc] = envp pointers
     *   p[argc+2+envc] = NULL (end of envp)
     *   p[argc+3+envc] = 0 (AT_NULL auxv key)
     *   p[argc+4+envc] = 0 (AT_NULL auxv value)
     */
    /* Sized for real-world parent environments. The original 16KB env
     * cap dropped trailing vars on GitHub Actions Linux runners (PATH
     * with nix store paths + GHA_* + RUNNER_* exceeds 16KB), which
     * silently dropped any var added by the parent via setenv() right
     * before posix_spawn — sortix's `basic/spawn/posix_spawn{,p}` set
     * `OS_TEST_POSIX_SPAWN` last and require the child to see it. The
     * old fork-based spawn hid the bug because env was inherited via
     * memory copy. 128KB matches typical Linux execve env limits. */
    #define MAX_ARGC 1024
    #define MAX_ENVC 1024
    #define ARGV_BUF_SIZE (64 * 1024)
    #define ENV_BUF_SIZE  (128 * 1024)

    static char argv_buf[ARGV_BUF_SIZE];
    static char env_buf[ENV_BUF_SIZE];
    /* argc + argv ptrs + NULL + envp ptrs + NULL + auxv(2) */
    static long start_data[MAX_ARGC + MAX_ENVC + 5];

    unsigned argc = kernel_get_argc();
    if (argc == 0) {
        /* No args set by host — default to "a.out" */
        static char prog_name[] = "a.out";
        argc = 1;
        start_data[1] = (long)prog_name;
    } else {
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
        argc = i;
    }

    start_data[0] = argc;
    start_data[1 + argc] = 0; /* argv NULL terminator */

    /* Populate envp from kernel's proc.environ */
    unsigned envc = kernel_environ_count();
    if (envc > MAX_ENVC) envc = MAX_ENVC;
    unsigned env_offset = 0;
    unsigned ei;
    for (ei = 0; ei < envc && env_offset < ENV_BUF_SIZE - 1; ei++) {
        int len = kernel_environ_get(ei, (unsigned char *)&env_buf[env_offset],
                                     ENV_BUF_SIZE - env_offset - 1);
        if (len < 0) break;
        env_buf[env_offset + len] = '\0';
        start_data[2 + argc + ei] = (long)&env_buf[env_offset];
        env_offset += len + 1;
    }
    envc = ei;

    start_data[2 + argc + envc] = 0; /* envp NULL terminator */
    start_data[3 + argc + envc] = 0; /* auxv AT_NULL */
    start_data[4 + argc + envc] = 0; /* auxv value */

    _start_c(start_data);
}
#endif /* !SHARED */
