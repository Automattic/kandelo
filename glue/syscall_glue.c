/*
 * syscall_glue.c — Dispatch __syscallN() calls to typed kernel_* Wasm imports.
 *
 * musl invokes __syscallN(SYS_xxx, args...) where N is the number of
 * arguments (0-6).  Each function here switches on the syscall number
 * and calls the correct kernel import with properly typed arguments.
 *
 * IMPORTANT: musl's syscall_cp() and the varargs syscall() function
 * always route through __syscall6 (with unused args set to 0).  So the
 * full dispatch lives in a single static __do_syscall, and the
 * public __syscallN functions delegate to it.
 *
 * Key responsibilities of this glue layer:
 *   - Convert C null-terminated strings to (ptr, len) pairs
 *   - Split 64-bit values into (lo, hi) pairs where the kernel expects them
 *   - Bridge musl's rt_sigaction/rt_sigprocmask to our simplified kernel API
 *   - Return -38 (ENOSYS) for unrecognised syscall numbers
 */

#include "syscall_imports.h"

/* ------------------------------------------------------------------ */
/* Syscall numbers — must match bits/syscall.h.in                      */
/* ------------------------------------------------------------------ */

#define SYS_OPEN            1
#define SYS_CLOSE           2
#define SYS_READ            3
#define SYS_WRITE           4
#define SYS_LSEEK           5
#define SYS_FSTAT           6
#define SYS_DUP             7
#define SYS_DUP2            8
#define SYS_PIPE            9
#define SYS_FCNTL          10
#define SYS_STAT           11
#define SYS_LSTAT          12
#define SYS_MKDIR          13
#define SYS_RMDIR          14
#define SYS_UNLINK         15
#define SYS_RENAME         16
#define SYS_LINK           17
#define SYS_SYMLINK        18
#define SYS_READLINK       19
#define SYS_CHMOD          20
#define SYS_CHOWN          21
#define SYS_ACCESS         22
#define SYS_GETCWD         23
#define SYS_CHDIR          24
#define SYS_OPENDIR        25
#define SYS_READDIR        26
#define SYS_CLOSEDIR       27
#define SYS_GETPID         28
#define SYS_GETPPID        29
#define SYS_GETUID         30
#define SYS_GETEUID        31
#define SYS_GETGID         32
#define SYS_GETEGID        33
#define SYS_EXIT           34
#define SYS_KILL           35
#define SYS_SIGACTION      36
#define SYS_SIGPROCMASK    37
#define SYS_RAISE          38
#define SYS_ALARM          39
#define SYS_CLOCK_GETTIME  40
#define SYS_NANOSLEEP      41
#define SYS_ISATTY         42
#define SYS_GETENV         43
#define SYS_SETENV         44
#define SYS_UNSETENV       45
#define SYS_MMAP           46
#define SYS_MUNMAP         47
#define SYS_BRK            48
#define SYS_MPROTECT       49
#define SYS_SOCKET         50
#define SYS_BIND           51
#define SYS_LISTEN         52
#define SYS_ACCEPT         53
#define SYS_CONNECT        54
#define SYS_SEND           55
#define SYS_RECV           56
#define SYS_SHUTDOWN       57
#define SYS_GETSOCKOPT     58
#define SYS_SETSOCKOPT     59
#define SYS_POLL           60
#define SYS_SOCKETPAIR     61
#define SYS_SENDTO         62
#define SYS_RECVFROM       63
#define SYS_PREAD          64
#define SYS_PWRITE         65
#define SYS_TIME           66
#define SYS_GETTIMEOFDAY   67
#define SYS_USLEEP         68
#define SYS_OPENAT         69
#define SYS_TCGETATTR      70
#define SYS_TCSETATTR      71
#define SYS_IOCTL          72
#define SYS_SIGNAL         73
#define SYS_UMASK          74
#define SYS_UNAME          75
#define SYS_SYSCONF        76
#define SYS_DUP3           77
#define SYS_PIPE2          78
#define SYS_FTRUNCATE      79
#define SYS_FSYNC          80
#define SYS_WRITEV         81
#define SYS_READV          82
#define SYS_GETRLIMIT      83
#define SYS_SETRLIMIT      84
#define SYS_TRUNCATE       85
#define SYS_FDATASYNC      86
#define SYS_FCHMOD         87
#define SYS_FCHOWN         88
#define SYS_GETPGRP        89
#define SYS_SETPGID        90
#define SYS_GETSID         91
#define SYS_SETSID         92
#define SYS_FSTATAT        93
#define SYS_UNLINKAT       94
#define SYS_MKDIRAT        95
#define SYS_RENAMEAT       96
#define SYS_FACCESSAT      97
#define SYS_FCHMODAT       98
#define SYS_FCHOWNAT       99
#define SYS_LINKAT        100
#define SYS_SYMLINKAT     101
#define SYS_READLINKAT    102
#define SYS_SELECT        103
#define SYS_SETUID        104
#define SYS_SETGID        105
#define SYS_SETEUID       106
#define SYS_SETEGID       107
#define SYS_GETRUSAGE     108
#define SYS_REALPATH      109
#define SYS_SIGSUSPEND    110
#define SYS_PAUSE         111
#define SYS_PATHCONF      112
#define SYS_FPATHCONF     113
#define SYS_GETSOCKNAME   114
#define SYS_GETPEERNAME   115
#define SYS_REWINDDIR     116
#define SYS_TELLDIR       117
#define SYS_SEEKDIR       118
#define SYS__LLSEEK       385

/* ENOSYS — returned for unknown syscall numbers */
#define ENOSYS_NEG (-38)

/* fcntl lock commands — must match kernel's crates/shared/src/lib.rs */
#define FCNTL_F_GETLK  5
#define FCNTL_F_SETLK  6
#define FCNTL_F_SETLKW 7

/* Buffer size hints for ioctl/termios where kernel needs a length */
#define IOCTL_BUF_SIZE    256
#define TERMIOS_BUF_SIZE  256

/* mmap2 page unit — musl divides the byte offset by this before syscall */
#define MMAP2_UNIT 4096U

/* ------------------------------------------------------------------ */
/* Helper: compute string length via compiler built-in                 */
/* ------------------------------------------------------------------ */

static inline unsigned int slen(const char *s)
{
    if (!s) return 0;
    return (unsigned int)__builtin_strlen(s);
}

/* ================================================================== */
/* Central dispatch — all __syscallN functions delegate here            */
/*                                                                     */
/* Every path through musl (macro __syscall, varargs syscall(), and    */
/* syscall_cp) ultimately reaches one of the __syscallN functions.     */
/* The varargs and syscall_cp paths always route through __syscall6    */
/* with unused args set to zero, so this single function handles all   */
/* cases.                                                              */
/* ================================================================== */

static long __do_syscall(long n, long a1, long a2, long a3,
                         long a4, long a5, long a6)
{
    switch (n) {

    /* ============================================================== */
    /* Process info (0-arg)                                            */
    /* ============================================================== */

    case SYS_GETPID:
        return (long)kernel_getpid();
    case SYS_GETPPID:
        return (long)kernel_getppid();
    case SYS_GETUID:
        return (long)kernel_getuid();
    case SYS_GETEUID:
        return (long)kernel_geteuid();
    case SYS_GETGID:
        return (long)kernel_getgid();
    case SYS_GETEGID:
        return (long)kernel_getegid();
    case SYS_GETPGRP:
        return (long)kernel_getpgrp();
    case SYS_SETSID:
        return (long)kernel_setsid();
    case SYS_PAUSE:
        return (long)kernel_pause();
    case SYS_TIME:
        return (long)kernel_time();  /* i64 truncated to 32-bit long */

    /* ============================================================== */
    /* File operations                                                 */
    /* ============================================================== */

    /* open — (path, flags) or (path, flags, mode) */
    case SYS_OPEN: {
        const char *p = (const char *)(uintptr_t)a1;
        return (long)kernel_open((const uint8_t *)p, slen(p),
                                 (uint32_t)a2, (uint32_t)a3);
    }

    /* close — (fd) */
    case SYS_CLOSE:
        return (long)kernel_close((int32_t)a1);

    /* read — (fd, buf, count) */
    case SYS_READ:
        return (long)kernel_read((int32_t)a1, (uint8_t *)(uintptr_t)a2,
                                 (uint32_t)a3);

    /* write — (fd, buf, count) */
    case SYS_WRITE:
        return (long)kernel_write((int32_t)a1,
                                  (const uint8_t *)(uintptr_t)a2,
                                  (uint32_t)a3);

    /* lseek — (fd, offset_lo, offset_hi, whence)
     *
     * Direct __syscall path: 4 args after splitting via __SYSCALL_LL_E. */
    case SYS_LSEEK:
        return (long)kernel_lseek((int32_t)a1, (uint32_t)a2,
                                  (int32_t)a3, (uint32_t)a4);

    /* _llseek — (fd, offset_hi, offset_lo, result_ptr, whence)
     *
     * musl's lseek.c on 32-bit arches uses SYS__llseek which passes
     * the 64-bit offset as two explicit 32-bit halves and writes the
     * result to a pointer. */
    case SYS__LLSEEK: {
        int64_t r = kernel_lseek((int32_t)a1, (uint32_t)a3,
                                  (int32_t)a2, (uint32_t)a5);
        if (r < 0) return (long)r;
        *(int64_t *)(uintptr_t)a4 = r;
        return 0;
    }

    /* pread — (fd, buf, count, off_lo, off_hi)
     * musl: syscall_cp(SYS_pread, fd, buf, size, __SYSCALL_LL_PRW(ofs))
     * __SYSCALL_LL_PRW → lo, hi → 5 data args */
    case SYS_PREAD:
        return (long)kernel_pread((int32_t)a1,
                                  (uint8_t *)(uintptr_t)a2,
                                  (uint32_t)a3,
                                  (uint32_t)a4, (int32_t)a5);

    /* pwrite — (fd, buf, count, off_lo, off_hi) */
    case SYS_PWRITE:
        return (long)kernel_pwrite((int32_t)a1,
                                   (const uint8_t *)(uintptr_t)a2,
                                   (uint32_t)a3,
                                   (uint32_t)a4, (int32_t)a5);

    /* ============================================================== */
    /* FD operations                                                   */
    /* ============================================================== */

    /* dup — (fd) */
    case SYS_DUP:
        return (long)kernel_dup((int32_t)a1);

    /* dup2 — (oldfd, newfd) */
    case SYS_DUP2:
        return (long)kernel_dup2((int32_t)a1, (int32_t)a2);

    /* dup3 — (oldfd, newfd, flags) */
    case SYS_DUP3:
        return (long)kernel_dup3((int32_t)a1, (int32_t)a2, (uint32_t)a3);

    /* pipe — (fildes_ptr) */
    case SYS_PIPE:
        return (long)kernel_pipe((int32_t *)(uintptr_t)a1);

    /* pipe2 — (fd_ptr, flags)
     * Note: kernel signature is pipe2(flags, fd_ptr) */
    case SYS_PIPE2:
        return (long)kernel_pipe2((uint32_t)a2, (int32_t *)(uintptr_t)a1);

    /* fcntl — (fd, cmd, arg)
     * Route lock commands (F_GETLK=5, F_SETLK=6, F_SETLKW=7) to
     * kernel_fcntl_lock where arg is a flock pointer. */
    case SYS_FCNTL: {
        uint32_t cmd = (uint32_t)a2;
        if (cmd == FCNTL_F_GETLK || cmd == FCNTL_F_SETLK ||
            cmd == FCNTL_F_SETLKW) {
            return (long)kernel_fcntl_lock((int32_t)a1, cmd,
                                           (uint8_t *)(uintptr_t)a3);
        }
        return (long)kernel_fcntl((int32_t)a1, cmd, (uint32_t)a3);
    }

    /* ============================================================== */
    /* Stat                                                            */
    /* ============================================================== */

    /* fstat — (fd, stat_ptr) */
    case SYS_FSTAT:
        return (long)kernel_fstat((int32_t)a1, (uint8_t *)(uintptr_t)a2);

    /* stat — (path, stat_ptr) */
    case SYS_STAT: {
        const char *p = (const char *)(uintptr_t)a1;
        return (long)kernel_stat((const uint8_t *)p, slen(p),
                                 (uint8_t *)(uintptr_t)a2);
    }

    /* lstat — (path, stat_ptr) */
    case SYS_LSTAT: {
        const char *p = (const char *)(uintptr_t)a1;
        return (long)kernel_lstat((const uint8_t *)p, slen(p),
                                  (uint8_t *)(uintptr_t)a2);
    }

    /* fstatat — (dirfd, path, stat_ptr, flags) */
    case SYS_FSTATAT: {
        const char *p = (const char *)(uintptr_t)a2;
        return (long)kernel_fstatat((int32_t)a1, (const uint8_t *)p,
                                    slen(p), (uint8_t *)(uintptr_t)a3,
                                    (uint32_t)a4);
    }

    /* ============================================================== */
    /* Directory operations                                            */
    /* ============================================================== */

    /* mkdir — (path, mode) */
    case SYS_MKDIR: {
        const char *p = (const char *)(uintptr_t)a1;
        return (long)kernel_mkdir((const uint8_t *)p, slen(p),
                                  (uint32_t)a2);
    }

    /* rmdir — (path) */
    case SYS_RMDIR: {
        const char *p = (const char *)(uintptr_t)a1;
        return (long)kernel_rmdir((const uint8_t *)p, slen(p));
    }

    /* unlink — (path) */
    case SYS_UNLINK: {
        const char *p = (const char *)(uintptr_t)a1;
        return (long)kernel_unlink((const uint8_t *)p, slen(p));
    }

    /* rename — (old_path, new_path) */
    case SYS_RENAME: {
        const char *oldp = (const char *)(uintptr_t)a1;
        const char *newp = (const char *)(uintptr_t)a2;
        return (long)kernel_rename((const uint8_t *)oldp, slen(oldp),
                                   (const uint8_t *)newp, slen(newp));
    }

    /* link — (old_path, new_path) */
    case SYS_LINK: {
        const char *oldp = (const char *)(uintptr_t)a1;
        const char *newp = (const char *)(uintptr_t)a2;
        return (long)kernel_link((const uint8_t *)oldp, slen(oldp),
                                 (const uint8_t *)newp, slen(newp));
    }

    /* symlink — (target, linkpath) */
    case SYS_SYMLINK: {
        const char *tgt = (const char *)(uintptr_t)a1;
        const char *lnk = (const char *)(uintptr_t)a2;
        return (long)kernel_symlink((const uint8_t *)tgt, slen(tgt),
                                    (const uint8_t *)lnk, slen(lnk));
    }

    /* readlink — (path, buf, bufsiz) */
    case SYS_READLINK: {
        const char *p = (const char *)(uintptr_t)a1;
        return (long)kernel_readlink((const uint8_t *)p, slen(p),
                                     (uint8_t *)(uintptr_t)a2,
                                     (uint32_t)a3);
    }

    /* chmod — (path, mode) */
    case SYS_CHMOD: {
        const char *p = (const char *)(uintptr_t)a1;
        return (long)kernel_chmod((const uint8_t *)p, slen(p),
                                  (uint32_t)a2);
    }

    /* chown — (path, uid, gid) */
    case SYS_CHOWN: {
        const char *p = (const char *)(uintptr_t)a1;
        return (long)kernel_chown((const uint8_t *)p, slen(p),
                                  (uint32_t)a2, (uint32_t)a3);
    }

    /* access — (path, amode) */
    case SYS_ACCESS: {
        const char *p = (const char *)(uintptr_t)a1;
        return (long)kernel_access((const uint8_t *)p, slen(p),
                                   (uint32_t)a2);
    }

    /* getcwd — (buf, size) */
    case SYS_GETCWD:
        return (long)kernel_getcwd((uint8_t *)(uintptr_t)a1, (uint32_t)a2);

    /* chdir — (path) */
    case SYS_CHDIR: {
        const char *p = (const char *)(uintptr_t)a1;
        return (long)kernel_chdir((const uint8_t *)p, slen(p));
    }

    /* opendir — (path) */
    case SYS_OPENDIR: {
        const char *p = (const char *)(uintptr_t)a1;
        return (long)kernel_opendir((const uint8_t *)p, slen(p));
    }

    /* readdir — (dir_handle, dirent_ptr, name_ptr, name_len) */
    case SYS_READDIR:
        return (long)kernel_readdir((int32_t)a1,
                                    (uint8_t *)(uintptr_t)a2,
                                    (uint8_t *)(uintptr_t)a3,
                                    (uint32_t)a4);

    /* closedir — (dir_handle) */
    case SYS_CLOSEDIR:
        return (long)kernel_closedir((int32_t)a1);

    /* rewinddir — (dir_handle) */
    case SYS_REWINDDIR:
        return (long)kernel_rewinddir((int32_t)a1);

    /* telldir — (dir_handle) → i64 truncated to long */
    case SYS_TELLDIR:
        return (long)kernel_telldir((int32_t)a1);

    /* seekdir — (dir_handle, loc_lo, loc_hi) */
    case SYS_SEEKDIR:
        return (long)kernel_seekdir((int32_t)a1, (uint32_t)a2,
                                    (uint32_t)a3);

    /* ============================================================== */
    /* Process control                                                 */
    /* ============================================================== */

    /* exit / exit_group — (status) */
    case SYS_EXIT:
        kernel_exit((int32_t)a1);
        __builtin_unreachable();

    /* ============================================================== */
    /* Signals                                                         */
    /* ============================================================== */

    /* kill — (pid, sig) */
    case SYS_KILL:
        return (long)kernel_kill((int32_t)a1, (uint32_t)a2);

    /* rt_sigaction — (sig, act_ptr, oldact_ptr, sigsetsize)
     *
     * Our kernel uses a simplified API: kernel_sigaction(sig, handler).
     * The k_sigaction struct layout on wasm32 (no SA_RESTORER):
     *   offset 0: handler (void (*)(int))  — 4 bytes
     *   offset 4: flags (unsigned long)    — 4 bytes
     *   offset 8: mask[2] (unsigned int)   — 8 bytes
     *   offset 16: unused (void *)         — 4 bytes
     * We extract the handler from act, call the kernel, and write
     * the old handler into oldact if requested.
     */
    case SYS_SIGACTION: {
        const uint32_t *act = (const uint32_t *)(uintptr_t)a2;
        uint32_t *oldact = (uint32_t *)(uintptr_t)a3;
        uint32_t handler = 0;
        if (act) {
            handler = act[0]; /* handler is first field */
        }
        int32_t r = kernel_sigaction((uint32_t)a1, act ? handler : 0);
        if (r >= 0 && oldact) {
            oldact[0] = (uint32_t)r;  /* old handler */
            oldact[1] = 0;            /* flags */
            oldact[2] = 0;            /* mask[0] */
            oldact[3] = 0;            /* mask[1] */
            oldact[4] = 0;            /* unused */
            r = 0;
        } else if (r >= 0) {
            r = 0;
        }
        return (long)r;
    }

    /* rt_sigprocmask — (how, set_ptr, oldset_ptr, sigsetsize)
     *
     * Our kernel: kernel_sigprocmask(how, set_lo, set_hi) → i64
     * set_ptr/oldset_ptr point to unsigned long[2] on wasm32.
     */
    case SYS_SIGPROCMASK: {
        const uint32_t *set = (const uint32_t *)(uintptr_t)a2;
        uint32_t *oldset = (uint32_t *)(uintptr_t)a3;
        uint32_t lo = 0, hi = 0;
        if (set) {
            lo = set[0];
            hi = set[1];
        }
        int64_t r = kernel_sigprocmask((uint32_t)a1, lo, hi);
        if (r >= 0 && oldset) {
            oldset[0] = (uint32_t)(r & 0xFFFFFFFF);
            oldset[1] = (uint32_t)((uint64_t)r >> 32);
        }
        return (r >= 0) ? 0 : (long)r;
    }

    /* raise — (sig) */
    case SYS_RAISE:
        return (long)kernel_raise((uint32_t)a1);

    /* alarm — (seconds) */
    case SYS_ALARM:
        return (long)kernel_alarm((uint32_t)a1);

    /* signal — (signum, handler) */
    case SYS_SIGNAL:
        return (long)kernel_signal((uint32_t)a1, (uint32_t)a2);

    /* rt_sigsuspend — (set_ptr, sigsetsize)
     * set_ptr points to unsigned long[2] signal mask */
    case SYS_SIGSUSPEND: {
        const uint32_t *set = (const uint32_t *)(uintptr_t)a1;
        uint32_t lo = 0, hi = 0;
        if (set) {
            lo = set[0];
            hi = set[1];
        }
        return (long)kernel_sigsuspend(lo, hi);
    }

    /* ============================================================== */
    /* Time                                                            */
    /* ============================================================== */

    /* clock_gettime — (clk_id, ts_ptr) */
    case SYS_CLOCK_GETTIME:
        return (long)kernel_clock_gettime((uint32_t)a1,
                                          (uint8_t *)(uintptr_t)a2);

    /* nanosleep — (req_ptr, rem_ptr)
     * Our kernel only takes req_ptr; rem is handled by musl. */
    case SYS_NANOSLEEP:
        return (long)kernel_nanosleep((const uint8_t *)(uintptr_t)a1);

    /* usleep — (usec) */
    case SYS_USLEEP:
        return (long)kernel_usleep((uint32_t)a1);

    /* gettimeofday — (tv_ptr, tz_ptr)
     * musl's struct timeval uses (long, long) = (4,4) bytes on wasm32,
     * but kernel_gettimeofday writes (i64, i64). Adapt the layout. */
    case SYS_GETTIMEOFDAY: {
        long *tv = (long *)(uintptr_t)a1;
        if (!tv) return -14; /* -EFAULT */
        int64_t sec, usec;
        int32_t r = kernel_gettimeofday(&sec, &usec);
        if (r == 0) {
            tv[0] = (long)sec;
            tv[1] = (long)usec;
        }
        return (long)r;
    }

    /* ============================================================== */
    /* Terminal / ioctl                                                 */
    /* ============================================================== */

    /* isatty — (fd) */
    case SYS_ISATTY:
        return (long)kernel_isatty((int32_t)a1);

    /* tcgetattr — (fd, termios_ptr)
     * kernel needs buf_len; provide generous hint */
    case SYS_TCGETATTR:
        return (long)kernel_tcgetattr((int32_t)a1,
                                      (uint8_t *)(uintptr_t)a2,
                                      TERMIOS_BUF_SIZE);

    /* tcsetattr — (fd, action, termios_ptr) */
    case SYS_TCSETATTR:
        return (long)kernel_tcsetattr((int32_t)a1, (uint32_t)a2,
                                      (const uint8_t *)(uintptr_t)a3,
                                      TERMIOS_BUF_SIZE);

    /* ioctl — (fd, request, arg_ptr)
     * kernel needs buf_len; provide generous hint */
    case SYS_IOCTL:
        return (long)kernel_ioctl((int32_t)a1, (uint32_t)a2,
                                  (uint8_t *)(uintptr_t)a3,
                                  IOCTL_BUF_SIZE);

    /* ============================================================== */
    /* Environment                                                     */
    /* ============================================================== */

    /* getenv — (name_ptr, buf_ptr, buf_len)
     * kernel: getenv(name_ptr, name_len, buf_ptr, buf_len) */
    case SYS_GETENV: {
        const char *name = (const char *)(uintptr_t)a1;
        return (long)kernel_getenv((const uint8_t *)name, slen(name),
                                   (uint8_t *)(uintptr_t)a2,
                                   (uint32_t)a3);
    }

    /* setenv — (name_ptr, val_ptr, overwrite)
     * kernel: setenv(name_ptr, name_len, val_ptr, val_len, overwrite) */
    case SYS_SETENV: {
        const char *name = (const char *)(uintptr_t)a1;
        const char *val = (const char *)(uintptr_t)a2;
        return (long)kernel_setenv((const uint8_t *)name, slen(name),
                                   (const uint8_t *)val, slen(val),
                                   (uint32_t)a3);
    }

    /* unsetenv — (name_ptr) */
    case SYS_UNSETENV: {
        const char *name = (const char *)(uintptr_t)a1;
        return (long)kernel_unsetenv((const uint8_t *)name, slen(name));
    }

    /* ============================================================== */
    /* Memory                                                          */
    /* ============================================================== */

    /* mmap2 — (addr, len, prot, flags, fd, offset_in_pages)
     * musl divides byte offset by 4096 before passing via SYS_mmap2.
     * Our kernel expects a byte offset split into (lo, hi).
     * Multiply back: byte_offset = offset_in_pages * 4096 */
    case SYS_MMAP: {
        unsigned long long byte_off =
            (unsigned long long)(uint32_t)a6 * MMAP2_UNIT;
        return (long)kernel_mmap((uint32_t)a1, (uint32_t)a2,
                                 (uint32_t)a3, (uint32_t)a4,
                                 (int32_t)a5,
                                 (uint32_t)(byte_off & 0xFFFFFFFF),
                                 (int32_t)(byte_off >> 32));
    }

    /* munmap — (addr, len) */
    case SYS_MUNMAP:
        return (long)kernel_munmap((uint32_t)a1, (uint32_t)a2);

    /* brk — (addr) */
    case SYS_BRK:
        return (long)kernel_brk((uint32_t)a1);

    /* mprotect — (addr, len, prot) */
    case SYS_MPROTECT:
        return (long)kernel_mprotect((uint32_t)a1, (uint32_t)a2,
                                     (uint32_t)a3);

    /* ============================================================== */
    /* Truncate / Sync                                                 */
    /* ============================================================== */

    /* ftruncate — (fd, length_lo, length_hi)
     * musl: syscall(SYS_ftruncate, fd, __SYSCALL_LL_O(length))
     * Through varargs: a1=fd, a2=lo, a3=hi */
    case SYS_FTRUNCATE:
        return (long)kernel_ftruncate((int32_t)a1, (uint32_t)a2,
                                      (uint32_t)a3);

    /* truncate — (path, length_lo, length_hi) */
    case SYS_TRUNCATE: {
        const char *p = (const char *)(uintptr_t)a1;
        return (long)kernel_truncate((const uint8_t *)p, slen(p),
                                     (uint32_t)a2, (uint32_t)a3);
    }

    /* fsync — (fd) */
    case SYS_FSYNC:
        return (long)kernel_fsync((int32_t)a1);

    /* fdatasync — (fd) */
    case SYS_FDATASYNC:
        return (long)kernel_fdatasync((int32_t)a1);

    /* fchmod — (fd, mode) */
    case SYS_FCHMOD:
        return (long)kernel_fchmod((int32_t)a1, (uint32_t)a2);

    /* fchown — (fd, uid, gid) */
    case SYS_FCHOWN:
        return (long)kernel_fchown((int32_t)a1, (uint32_t)a2,
                                   (uint32_t)a3);

    /* ============================================================== */
    /* Scatter-gather I/O                                              */
    /* ============================================================== */

    /* writev — (fd, iov, iovcnt) */
    case SYS_WRITEV:
        return (long)kernel_writev((int32_t)a1,
                                   (const uint8_t *)(uintptr_t)a2,
                                   (int32_t)a3);

    /* readv — (fd, iov, iovcnt) */
    case SYS_READV:
        return (long)kernel_readv((int32_t)a1,
                                  (uint8_t *)(uintptr_t)a2,
                                  (int32_t)a3);

    /* ============================================================== */
    /* Resource limits                                                 */
    /* ============================================================== */

    /* getrlimit — (resource, rlim_ptr) */
    case SYS_GETRLIMIT:
        return (long)kernel_getrlimit((uint32_t)a1,
                                      (uint8_t *)(uintptr_t)a2);

    /* setrlimit — (resource, rlim_ptr) */
    case SYS_SETRLIMIT:
        return (long)kernel_setrlimit((uint32_t)a1,
                                      (const uint8_t *)(uintptr_t)a2);

    /* getrusage — (who, buf_ptr, buf_len) */
    case SYS_GETRUSAGE:
        return (long)kernel_getrusage((int32_t)a1,
                                      (uint8_t *)(uintptr_t)a2,
                                      (uint32_t)a3);

    /* ============================================================== */
    /* System info                                                     */
    /* ============================================================== */

    /* umask — (mask) */
    case SYS_UMASK:
        return (long)kernel_umask((uint32_t)a1);

    /* uname — (buf_ptr, buf_len) */
    case SYS_UNAME:
        return (long)kernel_uname((uint8_t *)(uintptr_t)a1, (uint32_t)a2);

    /* sysconf — (name) */
    case SYS_SYSCONF:
        return (long)kernel_sysconf((int32_t)a1);

    /* pathconf — (path, name) */
    case SYS_PATHCONF: {
        const char *p = (const char *)(uintptr_t)a1;
        return (long)kernel_pathconf((const uint8_t *)p, slen(p),
                                     (int32_t)a2);
    }

    /* fpathconf — (fd, name) */
    case SYS_FPATHCONF:
        return (long)kernel_fpathconf((int32_t)a1, (int32_t)a2);

    /* realpath — (path, buf, buflen) */
    case SYS_REALPATH: {
        const char *p = (const char *)(uintptr_t)a1;
        return (long)kernel_realpath((const uint8_t *)p, slen(p),
                                     (uint8_t *)(uintptr_t)a2,
                                     (uint32_t)a3);
    }

    /* ============================================================== */
    /* Process group / session                                         */
    /* ============================================================== */

    /* setpgid — (pid, pgid) */
    case SYS_SETPGID:
        return (long)kernel_setpgid((uint32_t)a1, (uint32_t)a2);

    /* getsid — (pid) */
    case SYS_GETSID:
        return (long)kernel_getsid((uint32_t)a1);

    /* ============================================================== */
    /* User / Group                                                    */
    /* ============================================================== */

    case SYS_SETUID:
        return (long)kernel_setuid((uint32_t)a1);
    case SYS_SETGID:
        return (long)kernel_setgid((uint32_t)a1);
    case SYS_SETEUID:
        return (long)kernel_seteuid((uint32_t)a1);
    case SYS_SETEGID:
        return (long)kernel_setegid((uint32_t)a1);

    /* ============================================================== */
    /* *at() variants                                                  */
    /* ============================================================== */

    /* openat — (dirfd, path, flags, mode) */
    case SYS_OPENAT: {
        const char *p = (const char *)(uintptr_t)a2;
        return (long)kernel_openat((int32_t)a1, (const uint8_t *)p,
                                   slen(p), (uint32_t)a3, (uint32_t)a4);
    }

    /* unlinkat — (dirfd, path, flags) */
    case SYS_UNLINKAT: {
        const char *p = (const char *)(uintptr_t)a2;
        return (long)kernel_unlinkat((int32_t)a1, (const uint8_t *)p,
                                     slen(p), (uint32_t)a3);
    }

    /* mkdirat — (dirfd, path, mode) */
    case SYS_MKDIRAT: {
        const char *p = (const char *)(uintptr_t)a2;
        return (long)kernel_mkdirat((int32_t)a1, (const uint8_t *)p,
                                    slen(p), (uint32_t)a3);
    }

    /* renameat — (olddirfd, old_path, newdirfd, new_path) */
    case SYS_RENAMEAT: {
        const char *oldp = (const char *)(uintptr_t)a2;
        const char *newp = (const char *)(uintptr_t)a4;
        return (long)kernel_renameat((int32_t)a1,
                                     (const uint8_t *)oldp, slen(oldp),
                                     (int32_t)a3,
                                     (const uint8_t *)newp, slen(newp));
    }

    /* faccessat — (dirfd, path, amode, flags) */
    case SYS_FACCESSAT: {
        const char *p = (const char *)(uintptr_t)a2;
        return (long)kernel_faccessat((int32_t)a1, (const uint8_t *)p,
                                      slen(p), (uint32_t)a3,
                                      (uint32_t)a4);
    }

    /* fchmodat — (dirfd, path, mode, flags) */
    case SYS_FCHMODAT: {
        const char *p = (const char *)(uintptr_t)a2;
        return (long)kernel_fchmodat((int32_t)a1, (const uint8_t *)p,
                                     slen(p), (uint32_t)a3,
                                     (uint32_t)a4);
    }

    /* fchownat — (dirfd, path, uid, gid, flags) */
    case SYS_FCHOWNAT: {
        const char *p = (const char *)(uintptr_t)a2;
        return (long)kernel_fchownat((int32_t)a1, (const uint8_t *)p,
                                     slen(p), (uint32_t)a3,
                                     (uint32_t)a4, (uint32_t)a5);
    }

    /* linkat — (olddirfd, old_path, newdirfd, new_path, flags) */
    case SYS_LINKAT: {
        const char *oldp = (const char *)(uintptr_t)a2;
        const char *newp = (const char *)(uintptr_t)a4;
        return (long)kernel_linkat((int32_t)a1,
                                   (const uint8_t *)oldp, slen(oldp),
                                   (int32_t)a3,
                                   (const uint8_t *)newp, slen(newp),
                                   (uint32_t)a5);
    }

    /* symlinkat — (target, newdirfd, linkpath) */
    case SYS_SYMLINKAT: {
        const char *tgt = (const char *)(uintptr_t)a1;
        const char *lnk = (const char *)(uintptr_t)a3;
        return (long)kernel_symlinkat((const uint8_t *)tgt, slen(tgt),
                                      (int32_t)a2,
                                      (const uint8_t *)lnk, slen(lnk));
    }

    /* readlinkat — (dirfd, path, buf, bufsiz) */
    case SYS_READLINKAT: {
        const char *p = (const char *)(uintptr_t)a2;
        return (long)kernel_readlinkat((int32_t)a1, (const uint8_t *)p,
                                       slen(p),
                                       (uint8_t *)(uintptr_t)a3,
                                       (uint32_t)a4);
    }

    /* ============================================================== */
    /* Socket operations                                               */
    /* ============================================================== */

    /* socket — (domain, type, protocol) */
    case SYS_SOCKET:
        return (long)kernel_socket((uint32_t)a1, (uint32_t)a2,
                                   (uint32_t)a3);

    /* socketpair — (domain, type, protocol, sv_ptr) */
    case SYS_SOCKETPAIR:
        return (long)kernel_socketpair((uint32_t)a1, (uint32_t)a2,
                                       (uint32_t)a3,
                                       (int32_t *)(uintptr_t)a4);

    /* bind — (fd, addr, addrlen) */
    case SYS_BIND:
        return (long)kernel_bind((int32_t)a1,
                                 (const uint8_t *)(uintptr_t)a2,
                                 (uint32_t)a3);

    /* listen — (fd, backlog) */
    case SYS_LISTEN:
        return (long)kernel_listen((int32_t)a1, (uint32_t)a2);

    /* accept — (fd) */
    case SYS_ACCEPT:
        return (long)kernel_accept((int32_t)a1);

    /* connect — (fd, addr, addrlen) */
    case SYS_CONNECT:
        return (long)kernel_connect((int32_t)a1,
                                    (const uint8_t *)(uintptr_t)a2,
                                    (uint32_t)a3);

    /* send — (fd, buf, len, flags) */
    case SYS_SEND:
        return (long)kernel_send((int32_t)a1,
                                 (const uint8_t *)(uintptr_t)a2,
                                 (uint32_t)a3, (uint32_t)a4);

    /* recv — (fd, buf, len, flags) */
    case SYS_RECV:
        return (long)kernel_recv((int32_t)a1,
                                 (uint8_t *)(uintptr_t)a2,
                                 (uint32_t)a3, (uint32_t)a4);

    /* shutdown — (fd, how) */
    case SYS_SHUTDOWN:
        return (long)kernel_shutdown((int32_t)a1, (uint32_t)a2);

    /* getsockopt — (fd, level, optname, optval_ptr) */
    case SYS_GETSOCKOPT:
        return (long)kernel_getsockopt((int32_t)a1, (uint32_t)a2,
                                       (uint32_t)a3,
                                       (uint32_t *)(uintptr_t)a4);

    /* setsockopt — (fd, level, optname, optval) */
    case SYS_SETSOCKOPT:
        return (long)kernel_setsockopt((int32_t)a1, (uint32_t)a2,
                                       (uint32_t)a3, (uint32_t)a4);

    /* getsockname — (fd, buf_ptr, buf_len) */
    case SYS_GETSOCKNAME:
        return (long)kernel_getsockname((int32_t)a1, (uint32_t)a2,
                                        (uint32_t)a3);

    /* getpeername — (fd, buf_ptr, buf_len) */
    case SYS_GETPEERNAME:
        return (long)kernel_getpeername((int32_t)a1, (uint32_t)a2,
                                        (uint32_t)a3);

    /* ============================================================== */
    /* I/O multiplexing                                                */
    /* ============================================================== */

    /* poll — (fds, nfds, timeout) */
    case SYS_POLL:
        return (long)kernel_poll((uint8_t *)(uintptr_t)a1,
                                 (uint32_t)a2, (int32_t)a3);

    /* sendto — (fd, buf, len, flags, addr, addrlen) */
    case SYS_SENDTO:
        return (long)kernel_sendto((int32_t)a1,
                                   (const uint8_t *)(uintptr_t)a2,
                                   (uint32_t)a3, (uint32_t)a4,
                                   (const uint8_t *)(uintptr_t)a5,
                                   (uint32_t)a6);

    /* recvfrom — (fd, buf, len, flags, addr, addrlen) */
    case SYS_RECVFROM:
        return (long)kernel_recvfrom((int32_t)a1,
                                     (uint8_t *)(uintptr_t)a2,
                                     (uint32_t)a3, (uint32_t)a4,
                                     (uint8_t *)(uintptr_t)a5,
                                     (uint32_t)a6);

    /* select — (nfds, readfds, writefds, exceptfds, timeout_ms) */
    case SYS_SELECT:
        return (long)kernel_select((int32_t)a1,
                                   (uint8_t *)(uintptr_t)a2,
                                   (uint8_t *)(uintptr_t)a3,
                                   (uint8_t *)(uintptr_t)a4,
                                   (int32_t)a5);

    /* ============================================================== */
    /* Default: unknown syscall                                        */
    /* ============================================================== */

    default:
        return ENOSYS_NEG;
    }
}

/* ================================================================== */
/* Public __syscallN entry points — delegate to __do_syscall            */
/* ================================================================== */

long __syscall0(long n)
{
    return __do_syscall(n, 0, 0, 0, 0, 0, 0);
}

long __syscall1(long n, long a1)
{
    return __do_syscall(n, a1, 0, 0, 0, 0, 0);
}

long __syscall2(long n, long a1, long a2)
{
    return __do_syscall(n, a1, a2, 0, 0, 0, 0);
}

long __syscall3(long n, long a1, long a2, long a3)
{
    return __do_syscall(n, a1, a2, a3, 0, 0, 0);
}

long __syscall4(long n, long a1, long a2, long a3, long a4)
{
    return __do_syscall(n, a1, a2, a3, a4, 0, 0);
}

long __syscall5(long n, long a1, long a2, long a3, long a4, long a5)
{
    return __do_syscall(n, a1, a2, a3, a4, a5, 0);
}

long __syscall6(long n, long a1, long a2, long a3, long a4, long a5, long a6)
{
    return __do_syscall(n, a1, a2, a3, a4, a5, a6);
}
