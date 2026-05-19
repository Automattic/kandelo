/*
 * crt_arch.h — Wasm64 CRT entry point.
 *
 * Same as wasm32posix but with 64-bit pointer params for kernel imports.
 */
#define START "_start"

#ifndef SHARED
void _start_c(long *);

/* Kernel imports for argv support — wasm64 uses i64 for pointers */
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
