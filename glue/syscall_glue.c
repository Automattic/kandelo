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
#define SYS__LLSEEK       119
#define SYS_GETRANDOM     120
#define SYS_FLOCK         121
#define SYS_GETDENTS64    122
#define SYS_CLOCK_GETRES  123
#define SYS_CLOCK_NANOSLEEP 124
#define SYS_UTIMENSAT     125
#define SYS_MREMAP        126
#define SYS_FCHDIR        127
#define SYS_MADVISE       128
#define SYS_STATFS        129
#define SYS_FSTATFS       130
#define SYS_SETRESUID     131
#define SYS_GETRESUID     132
#define SYS_SETRESGID     133
#define SYS_GETRESGID     134
#define SYS_GETGROUPS     135
#define SYS_SETGROUPS     136
#define SYS_SENDMSG       137
#define SYS_RECVMSG       138
#define SYS_WAIT4         139
#define SYS_GETADDRINFO   140
/* Batch 4+ syscalls (200+ range) */
#define SYS_FUTEX         200
#define SYS_CLONE         201
#define SYS_GETTID        202
#define SYS_SET_TID_ADDRESS 203
#define SYS_TKILL         204
#define SYS_RT_SIGQUEUEINFO 205
#define SYS_RT_SIGTIMEDWAIT 207
#define SYS_RT_SIGRETURN  208
#define SYS_SIGALTSTACK   209
#define SYS_EXECVE        211
#define SYS_FORK          212
#define SYS_VFORK         213
#define SYS_PRCTL         223
#define SYS_GETITIMER     224
#define SYS_SETITIMER     225
#define SYS_CLOCK_SETTIME 226
#define SYS_SCHED_GETPARAM 230
#define SYS_SCHED_SETPARAM 231
#define SYS_SCHED_GETSCHEDULER 232
#define SYS_SCHED_SETSCHEDULER 233
#define SYS_SCHED_GET_PRIORITY_MAX 234
#define SYS_SCHED_GET_PRIORITY_MIN 235
#define SYS_SCHED_RR_GET_INTERVAL 236
#define SYS_SCHED_SETAFFINITY 237
#define SYS_SCHED_GETAFFINITY 238
#define SYS_EPOLL_CREATE1 239
#define SYS_EPOLL_CTL     240
#define SYS_EPOLL_PWAIT   241
#define SYS_EVENTFD2      242
#define SYS_TIMERFD_CREATE 243
#define SYS_TIMERFD_SETTIME 244
#define SYS_TIMERFD_GETTIME 245
#define SYS_SIGNALFD4     246
#define SYS_INOTIFY_INIT1 247
#define SYS_INOTIFY_ADD_WATCH 248
#define SYS_INOTIFY_RM_WATCH 249
#define SYS_PRLIMIT64     250
#define SYS_PPOLL         251
#define SYS_PSELECT6      252
#define SYS_RECVMMSG      253
#define SYS_SENDMMSG      254
#define SYS_MEMFD_CREATE  256
#define SYS_MEMBARRIER    257
#define SYS_STATX         260
#define SYS_SET_ROBUST_LIST 261
#define SYS_GET_ROBUST_LIST 262
#define SYS_CHROOT        265
#define SYS_MOUNT         266
#define SYS_UMOUNT2       267
#define SYS_REBOOT        268
#define SYS_MKNOD         271
#define SYS_MKNODAT       272
#define SYS_SYNC          273
#define SYS_SYNCFS        274
#define SYS_PERSONALITY   287
#define SYS_UNSHARE       289
#define SYS_COPY_FILE_RANGE 290
#define SYS_SPLICE        291
#define SYS_TEE           292
#define SYS_READAHEAD     293
#define SYS_SENDFILE      294
#define SYS_PREADV        295
#define SYS_PWRITEV       296
#define SYS_PREADV2       297
#define SYS_PWRITEV2      298
#define SYS_ACCT          301
#define SYS_CAPGET        302
#define SYS_CAPSET        303
#define SYS_SYSLOG        304
#define SYS_PTRACE        305
#define SYS_RENAMEAT2     306
#define SYS_FALLOCATE     308
#define SYS_NAME_TO_HANDLE_AT 309
#define SYS_OPEN_BY_HANDLE_AT 310
#define SYS_SETNS         311
#define SYS_PROCESS_VM_READV 312
#define SYS_PROCESS_VM_WRITEV 313
#define SYS_PIVOT_ROOT    314
#define SYS_SWAPON        315
#define SYS_SWAPOFF       316
#define SYS_DELETE_MODULE  317
#define SYS_INIT_MODULE   318
#define SYS_QUOTACTL      319
#define SYS_SETHOSTNAME   320
#define SYS_SETDOMAINNAME 321
#define SYS_VHANGUP       322
#define SYS_SYNC_FILE_RANGE 323
#define SYS_REMAP_FILE_PAGES 324
#define SYS_GETCPU        325
#define SYS_TIMER_CREATE  326
#define SYS_TIMER_SETTIME 327
#define SYS_TIMER_GETTIME 328
#define SYS_TIMER_GETOVERRUN 329
#define SYS_TIMER_DELETE  330
#define SYS_MQ_OPEN       331
#define SYS_MQ_UNLINK     332
#define SYS_MQ_TIMEDSEND  333
#define SYS_MQ_TIMEDRECEIVE 334
#define SYS_MQ_NOTIFY     335
#define SYS_MQ_GETSETATTR 336
#define SYS_MSGGET        337
#define SYS_MSGRCV        338
#define SYS_MSGSND        339
#define SYS_MSGCTL        340
#define SYS_SEMGET        341
#define SYS_SEMOP         342
#define SYS_SEMCTL        343
#define SYS_SHMGET        344
#define SYS_SHMAT         345
#define SYS_SHMDT         346
#define SYS_SHMCTL        347
#define SYS_FANOTIFY_INIT 348
#define SYS_FANOTIFY_MARK 349
#define SYS_FGETXATTR     350
#define SYS_FLISTXATTR    351
#define SYS_FREMOVEXATTR  352
#define SYS_FSETXATTR     353
#define SYS_GETXATTR      354
#define SYS_LISTXATTR     355
#define SYS_LGETXATTR     356
#define SYS_LLISTXATTR    357
#define SYS_LREMOVEXATTR  358
#define SYS_LSETXATTR     359
#define SYS_REMOVEXATTR   360
#define SYS_SETXATTR      361
#define SYS_UTIMES        363
#define SYS_FUTIMESAT     364
#define SYS_CLOCK_ADJTIME 365
#define SYS_ADJTIMEX      366
#define SYS_SETTIMEOFDAY  367
#define SYS_SEMTIMEDOP    368
#define SYS_VMSPLICE      369
#define SYS_SETFSUID      370
#define SYS_SETFSGID      371
#define SYS_IPC           373
#define SYS_SET_THREAD_AREA 374
#define SYS_IOPERM        375
#define SYS_IOPL          376
#define SYS_SIGNALFD      377
#define SYS_EPOLL_CREATE  378
#define SYS_EPOLL_WAIT    379
#define SYS_EVENTFD       380
#define SYS_INOTIFY_INIT  381
#define SYS_FACCESSAT2    382
#define SYS_FCHMODAT2     383
#define SYS_EXECVEAT      386

/* ENOSYS — returned for unknown syscall numbers */
#define ENOSYS_NEG (-38)

/* fcntl lock commands — must match kernel's crates/shared/src/lib.rs */
#define FCNTL_F_GETLK  12
#define FCNTL_F_SETLK  13
#define FCNTL_F_SETLKW 14

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
     * Route lock commands (F_GETLK=12, F_SETLK=13, F_SETLKW=14) to
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
        /* musl k_sigaction layout (wasm32):
         *   offset 0: handler (void (*)(int))  — 4 bytes
         *   offset 4: flags (unsigned long)    — 4 bytes
         *   offset 8: restorer (void (*)(void))— 4 bytes  (unused)
         *   offset 12: mask[2] (unsigned long) — 8 bytes
         *
         * Kernel struct layout (16 bytes):
         *   [0..4] handler, [4..8] flags, [8..16] mask (u64)
         */
        const uint32_t *act = (const uint32_t *)(uintptr_t)a2;
        uint32_t *oldact = (uint32_t *)(uintptr_t)a3;

        /* Build kernel-format struct from musl k_sigaction */
        uint8_t k_act[16];
        const uint8_t *act_ptr = 0;
        if (act) {
            uint32_t handler = act[0];
            uint32_t flags   = act[1];
            uint32_t mask_lo = act[3]; /* offset 12 = act[3] */
            uint32_t mask_hi = act[4]; /* offset 16 = act[4] */
            __builtin_memcpy(k_act + 0,  &handler, 4);
            __builtin_memcpy(k_act + 4,  &flags,   4);
            __builtin_memcpy(k_act + 8,  &mask_lo, 4);
            __builtin_memcpy(k_act + 12, &mask_hi, 4);
            act_ptr = k_act;
        }

        uint8_t k_oldact[16] = {0};
        int32_t r = kernel_sigaction((uint32_t)a1, act_ptr,
                                     oldact ? k_oldact : (uint8_t *)0);
        if (r == 0 && oldact) {
            uint32_t old_handler, old_flags, old_mask_lo, old_mask_hi;
            __builtin_memcpy(&old_handler, k_oldact + 0,  4);
            __builtin_memcpy(&old_flags,   k_oldact + 4,  4);
            __builtin_memcpy(&old_mask_lo, k_oldact + 8,  4);
            __builtin_memcpy(&old_mask_hi, k_oldact + 12, 4);
            oldact[0] = old_handler;
            oldact[1] = old_flags;
            oldact[2] = 0;            /* restorer (unused) */
            oldact[3] = old_mask_lo;
            oldact[4] = old_mask_hi;
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

    /* tkill — (tid, sig).  Single-threaded: ignore tid, delegate to raise. */
    case SYS_TKILL:
        return (long)kernel_raise((uint32_t)a2);

    /* alarm — (seconds) */
    case SYS_ALARM:
        return (long)kernel_alarm((uint32_t)a1);

    /* signal — (signum, handler) */
    case SYS_SIGNAL:
        return (long)kernel_signal((uint32_t)a1, (uint32_t)a2);

    /* sigaltstack — (ss, old_ss)
     * Store/retrieve alternate signal stack info.
     * Note: Wasm cannot truly use alternate stacks, but we track the state
     * so sigaltstack queries work and programs don't get ENOSYS.
     * struct stack_t { void *ss_sp; int ss_flags; size_t ss_size; } = 12 bytes. */
    case SYS_SIGALTSTACK: {
        static uint32_t alt_sp = 0;
        static int32_t  alt_flags = 2; /* SS_DISABLE initially */
        static uint32_t alt_size = 0;

        const uint32_t *ss_new = (const uint32_t *)(uintptr_t)a1;
        uint32_t *ss_old = (uint32_t *)(uintptr_t)a2;

        /* Write old value first */
        if (ss_old) {
            ss_old[0] = alt_sp;
            ss_old[1] = (uint32_t)alt_flags;
            ss_old[2] = alt_size;
        }

        /* Set new value */
        if (ss_new) {
            int32_t flags = (int32_t)ss_new[1];
            uint32_t size = ss_new[2];

            /* Validate flags — only SS_DISABLE (2) and 0 are valid */
            if (flags & ~(0x2 | 0x1)) /* ~(SS_DISABLE | SS_ONSTACK) */
                return -22; /* -EINVAL */

            if (!(flags & 0x2)) { /* not SS_DISABLE */
                /* Check minimum size */
                if (size < 2048) /* MINSIGSTKSZ */
                    return -12; /* -ENOMEM */
            }

            alt_sp = ss_new[0];
            alt_flags = flags;
            alt_size = size;
        }

        return 0;
    }

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

    /* getsockname — (fd, addr, addrlen_ptr) */
    case SYS_GETSOCKNAME: {
        uint32_t *addrlen_ptr = (uint32_t *)(uintptr_t)a3;
        uint32_t buf_len = *addrlen_ptr;
        int32_t ret = kernel_getsockname((int32_t)a1, (uint32_t)a2, buf_len);
        if (ret >= 0) {
            *addrlen_ptr = (uint32_t)ret;
            return 0;
        }
        return (long)ret;
    }

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

    /* recvfrom — (fd, buf, len, flags, addr, addrlen_ptr) */
    case SYS_RECVFROM: {
        uint32_t addr_buf_len = 0;
        uint32_t *addrlen_ptr = (uint32_t *)(uintptr_t)a6;
        if (addrlen_ptr) {
            addr_buf_len = *addrlen_ptr;
        }
        int32_t ret = kernel_recvfrom((int32_t)a1,
                                      (uint8_t *)(uintptr_t)a2,
                                      (uint32_t)a3, (uint32_t)a4,
                                      (uint8_t *)(uintptr_t)a5,
                                      addr_buf_len);
        if (ret >= 0 && addrlen_ptr && a5) {
            /* kernel_recvfrom returns data bytes; addr is 16 bytes for sockaddr_in */
            *addrlen_ptr = 16;
        }
        return (long)ret;
    }

    /* select — (nfds, readfds, writefds, exceptfds, timeout_ms) */
    case SYS_SELECT:
        return (long)kernel_select((int32_t)a1,
                                   (uint8_t *)(uintptr_t)a2,
                                   (uint8_t *)(uintptr_t)a3,
                                   (uint8_t *)(uintptr_t)a4,
                                   (int32_t)a5);

    /* ============================================================== */
    /* Random                                                          */
    /* ============================================================== */

    /* getrandom — (buf, buflen, flags) */
    case SYS_GETRANDOM:
        return (long)kernel_getrandom((uint8_t *)(uintptr_t)a1,
                                      (uint32_t)a2, (uint32_t)a3);

    /* flock — (fd, operation) */
    case SYS_FLOCK:
        return (long)kernel_flock((int32_t)a1, (uint32_t)a2);

    /* getdents64 — (fd, buf, count) */
    case SYS_GETDENTS64:
        return (long)kernel_getdents64((int32_t)a1,
                                       (uint8_t *)(uintptr_t)a2,
                                       (uint32_t)a3);

    /* clock_getres — (clk_id, ts_ptr) */
    case SYS_CLOCK_GETRES:
        return (long)kernel_clock_getres((uint32_t)a1,
                                         (uint8_t *)(uintptr_t)a2);

    /* clock_nanosleep — (clk_id, flags, req_ptr, rem_ptr)
     * rem_ptr (a4) is ignored — kernel handles it internally */
    case SYS_CLOCK_NANOSLEEP:
        return (long)kernel_clock_nanosleep((uint32_t)a1, (uint32_t)a2,
                                            (const uint8_t *)(uintptr_t)a3);

    /* utimensat — (dirfd, path, times, flags) */
    case SYS_UTIMENSAT: {
        const char *p = (const char *)(uintptr_t)a2;
        return (long)kernel_utimensat((int32_t)a1, (const uint8_t *)p,
                                      slen(p),
                                      (const uint8_t *)(uintptr_t)a3,
                                      (uint32_t)a4);
    }

    /* mremap — (old_addr, old_size, new_size, flags) */
    case SYS_MREMAP:
        return (long)kernel_mremap((uint32_t)a1, (uint32_t)a2,
                                   (uint32_t)a3, (uint32_t)a4);

    /* fchdir — (fd) */
    case SYS_FCHDIR:
        return (long)kernel_fchdir((int32_t)a1);

    /* madvise — (addr, length, advice) → no-op */
    case SYS_MADVISE:
        return (long)kernel_madvise((uint32_t)a1, (uint32_t)a2, (uint32_t)a3);

    /* ============================================================== */
    /* Filesystem info                                                 */
    /* ============================================================== */

    /* statfs / statfs64 — musl aliases SYS_statfs64 = SYS_statfs and calls
       with 3 args: (path, sizeof buf, buf).  Handle both 2-arg and 3-arg. */
    case SYS_STATFS: {
        const char *p = (const char *)(uintptr_t)a1;
        uint8_t *buf = a3 ? (uint8_t *)(uintptr_t)a3
                          : (uint8_t *)(uintptr_t)a2;
        return (long)kernel_statfs((const uint8_t *)p, slen(p), buf);
    }

    /* fstatfs / fstatfs64 — same 3-arg pattern: (fd, sizeof buf, buf) */
    case SYS_FSTATFS: {
        uint8_t *buf = a3 ? (uint8_t *)(uintptr_t)a3
                          : (uint8_t *)(uintptr_t)a2;
        return (long)kernel_fstatfs((int32_t)a1, buf);
    }

    /* ============================================================== */
    /* Identity (res* variants)                                        */
    /* ============================================================== */

    /* setresuid — (ruid, euid, suid) */
    case SYS_SETRESUID:
        return (long)kernel_setresuid((uint32_t)a1, (uint32_t)a2, (uint32_t)a3);

    /* getresuid — (ruid_ptr, euid_ptr, suid_ptr) */
    case SYS_GETRESUID:
        return (long)kernel_getresuid((uint32_t *)(uintptr_t)a1,
                                      (uint32_t *)(uintptr_t)a2,
                                      (uint32_t *)(uintptr_t)a3);

    /* setresgid — (rgid, egid, sgid) */
    case SYS_SETRESGID:
        return (long)kernel_setresgid((uint32_t)a1, (uint32_t)a2, (uint32_t)a3);

    /* getresgid — (rgid_ptr, egid_ptr, sgid_ptr) */
    case SYS_GETRESGID:
        return (long)kernel_getresgid((uint32_t *)(uintptr_t)a1,
                                      (uint32_t *)(uintptr_t)a2,
                                      (uint32_t *)(uintptr_t)a3);

    /* getgroups — (size, list_ptr) */
    case SYS_GETGROUPS:
        return (long)kernel_getgroups((uint32_t)a1,
                                      (uint32_t *)(uintptr_t)a2);

    /* setgroups — (size, list_ptr) */
    case SYS_SETGROUPS:
        return (long)kernel_setgroups((uint32_t)a1,
                                      (const uint32_t *)(uintptr_t)a2);

    /* ============================================================== */
    /* Message-based socket I/O                                        */
    /* ============================================================== */

    /* sendmsg — (fd, msg_ptr, flags) */
    case SYS_SENDMSG:
        return (long)kernel_sendmsg((int32_t)a1,
                                    (const uint8_t *)(uintptr_t)a2,
                                    (uint32_t)a3);

    /* recvmsg — (fd, msg_ptr, flags) */
    case SYS_RECVMSG:
        return (long)kernel_recvmsg((int32_t)a1,
                                    (uint8_t *)(uintptr_t)a2,
                                    (uint32_t)a3);

    /* getaddrinfo — (name, result_ptr) */
    case SYS_GETADDRINFO: {
        const char *name = (const char *)a1;
        unsigned name_len = __builtin_strlen(name);
        return kernel_getaddrinfo((const uint8_t *)name, name_len, (uint8_t *)a2);
    }

    /* ============================================================== */
    /* Process waiting                                                 */
    /* ============================================================== */

    /* wait4 — (pid, wstatus, options, rusage) */
    case SYS_WAIT4:
        return (long)kernel_wait4((int32_t)a1,
                                  (int32_t *)(uintptr_t)a2,
                                  (uint32_t)a3,
                                  (uint8_t *)(uintptr_t)a4);

    /* ============================================================== */
    /* prlimit64 — delegates to existing getrlimit/setrlimit           */
    /* ============================================================== */

    /* prlimit64 — (pid, resource, new_limit, old_limit)
     * pid is ignored (single-process). If new_limit != NULL, call
     * kernel_setrlimit; if old_limit != NULL, call kernel_getrlimit. */
    case SYS_PRLIMIT64: {
        uint32_t resource = (uint32_t)a2;
        const uint8_t *new_rlim = (const uint8_t *)(uintptr_t)a3;
        uint8_t *old_rlim = (uint8_t *)(uintptr_t)a4;
        int32_t r = 0;
        if (new_rlim) {
            r = kernel_setrlimit(resource, new_rlim);
            if (r < 0) return (long)r;
        }
        if (old_rlim) {
            r = kernel_getrlimit(resource, old_rlim);
        }
        return (long)r;
    }

    /* ============================================================== */
    /* Process control                                                 */
    /* ============================================================== */

    case SYS_PRCTL: {
        /* prctl(option, arg2, arg3, arg4, arg5)
         * For PR_SET_NAME(15): arg2 is pointer to name string
         * For PR_GET_NAME(16): arg2 is pointer to name buffer
         * We pass arg2 as buf_ptr for both cases.
         */
        uint32_t option = (uint32_t)a1;
        uint8_t *buf = (uint8_t *)(uintptr_t)a2;
        uint32_t buf_len = 16; /* thread name is always 16 bytes */
        return (long)kernel_prctl(option, (uint32_t)a3, buf, buf_len);
    }

    /* ============================================================== */
    /* Runtime init stubs (single-threaded)                             */
    /* ============================================================== */

    case SYS_GETTID:
        /* STUB: single-threaded — tid == pid */
        return (long)kernel_gettid();

    case SYS_SET_TID_ADDRESS:
        /* STUB: single-threaded — ignore tidptr, return pid */
        return (long)kernel_set_tid_address((uint32_t)(uintptr_t)a1);

    case SYS_SET_ROBUST_LIST:
        return (long)kernel_set_robust_list((uint32_t)(uintptr_t)a1, (uint32_t)a2);

    case SYS_GET_ROBUST_LIST:
        return (long)kernel_get_robust_list((uint32_t)a1, (uint32_t)(uintptr_t)a2, (uint32_t)(uintptr_t)a3);

    /* ============================================================== */
    /* Futex stub (single-threaded)                                    */
    /* ============================================================== */

    case SYS_FUTEX:
        /* STUB: single-threaded — see plan for threading upgrade notes */
        return (long)kernel_futex(
            (uint32_t)(uintptr_t)a1,  /* uaddr */
            (uint32_t)a2,              /* op */
            (uint32_t)a3,              /* val */
            (uint32_t)(uintptr_t)a4,  /* timeout */
            (uint32_t)(uintptr_t)a5,  /* uaddr2 */
            (uint32_t)a6               /* val3 */
        );

    /* ============================================================== */
    /* epoll stubs — return ENOSYS, programs fall back to poll()        */
    /* ============================================================== */

    case SYS_EPOLL_CREATE1:
        return (long)kernel_epoll_create1((uint32_t)a1);

    case SYS_EPOLL_CTL:
        return (long)kernel_epoll_ctl((int32_t)a1, (int32_t)a2, (int32_t)a3, (uint8_t *)(uintptr_t)a4);

    case SYS_EPOLL_PWAIT:
        return (long)kernel_epoll_pwait((int32_t)a1, (uint8_t *)(uintptr_t)a2, (int32_t)a3, (int32_t)a4, (uint32_t)(uintptr_t)a5);

    /* ============================================================== */
    /* ppoll — poll with signal mask                                    */
    /* ============================================================== */

    case SYS_PPOLL: {
        /* ppoll(fds, nfds, timeout_ts, sigmask, sigsetsize)
         * Convert timespec to timeout_ms, extract sigmask, delegate to kernel.
         */
        uint8_t *fds_ptr = (uint8_t *)(uintptr_t)a1;
        uint32_t nfds = (uint32_t)a2;
        const int32_t *ts = (const int32_t *)(uintptr_t)a3;
        int32_t timeout_ms;
        if (!ts) {
            timeout_ms = -1; /* infinite */
        } else {
            int32_t sec = ts[0];
            int32_t nsec = ts[1];
            timeout_ms = sec * 1000 + nsec / 1000000;
            if (timeout_ms == 0 && (sec > 0 || nsec > 0))
                timeout_ms = 1; /* round up to at least 1ms */
        }
        const uint32_t *sigmask = (const uint32_t *)(uintptr_t)a4;
        uint32_t mask_lo = sigmask ? sigmask[0] : 0;
        uint32_t mask_hi = sigmask ? sigmask[1] : 0;
        return (long)kernel_ppoll(fds_ptr, nfds, timeout_ms, mask_lo, mask_hi);
    }

    /* ============================================================== */
    /* pselect6 — select with signal mask                              */
    /* ============================================================== */

    case SYS_PSELECT6: {
        /* pselect6(nfds, readfds, writefds, exceptfds, timeout_ts, sigmask_struct)
         * sigmask_struct is {sigset_t *mask, size_t size}
         * Convert timespec to timeout_ms, extract sigmask, delegate to kernel.
         */
        int32_t nfds = (int32_t)a1;
        uint8_t *readfds_ptr = (uint8_t *)(uintptr_t)a2;
        uint8_t *writefds_ptr = (uint8_t *)(uintptr_t)a3;
        uint8_t *exceptfds_ptr = (uint8_t *)(uintptr_t)a4;
        const int32_t *ts = (const int32_t *)(uintptr_t)a5;
        int32_t timeout_ms;
        if (!ts) {
            timeout_ms = -1; /* infinite */
        } else {
            int32_t sec = ts[0];
            int32_t nsec = ts[1];
            timeout_ms = sec * 1000 + nsec / 1000000;
            if (timeout_ms == 0 && (sec > 0 || nsec > 0))
                timeout_ms = 1;
        }
        /* a6 is pointer to {sigset_t *mask, size_t size} */
        const uint32_t *sigmask_struct = (const uint32_t *)(uintptr_t)a6;
        uint32_t mask_lo = 0, mask_hi = 0;
        if (sigmask_struct) {
            const uint32_t *mask_ptr = (const uint32_t *)(uintptr_t)sigmask_struct[0];
            if (mask_ptr) {
                mask_lo = mask_ptr[0];
                mask_hi = mask_ptr[1];
            }
        }
        return (long)kernel_pselect6(nfds, readfds_ptr, writefds_ptr,
                                     exceptfds_ptr, timeout_ms, mask_lo, mask_hi);
    }

    /* ============================================================== */
    /* setitimer / getitimer — interval timers (fixes musl alarm())   */
    /* ============================================================== */

    case SYS_SETITIMER:
        return (long)kernel_setitimer((uint32_t)a1,
                                      (const uint8_t *)(uintptr_t)a2,
                                      (uint8_t *)(uintptr_t)a3);

    case SYS_GETITIMER:
        return (long)kernel_getitimer((uint32_t)a1,
                                      (uint8_t *)(uintptr_t)a2);

    /* ============================================================== */
    /* rt_sigtimedwait — wait for signal from set                      */
    /* ============================================================== */

    case SYS_RT_SIGTIMEDWAIT: {
        const uint32_t *set = (const uint32_t *)(uintptr_t)a1;
        uint32_t mask_lo = set ? set[0] : 0;
        uint32_t mask_hi = set ? set[1] : 0;
        const int32_t *ts = (const int32_t *)(uintptr_t)a2;
        int32_t timeout_ms;
        if (!ts) {
            timeout_ms = -1;
        } else {
            int32_t sec = ts[0];
            int32_t nsec = ts[1];
            timeout_ms = sec * 1000 + nsec / 1000000;
            if (timeout_ms == 0 && (sec > 0 || nsec > 0))
                timeout_ms = 1;
        }
        return (long)kernel_rt_sigtimedwait(mask_lo, mask_hi, timeout_ms);
    }

    /* rt_sigqueueinfo — send signal with data (simplified: just raise) */
    case SYS_RT_SIGQUEUEINFO:
        return (long)kernel_raise((uint32_t)a2);

    /* rt_sigreturn — signal trampoline return (handled by host) */
    case SYS_RT_SIGRETURN:
        return 0;

    /* ============================================================== */
    /* Scatter-gather I/O with offset                                  */
    /* ============================================================== */

    /* preadv — (fd, iov, iovcnt, off_lo, off_hi) */
    case SYS_PREADV:
        return (long)kernel_preadv((int32_t)a1,
                                   (uint8_t *)(uintptr_t)a2,
                                   (int32_t)a3,
                                   (uint32_t)a4, (int32_t)a5);

    /* pwritev — (fd, iov, iovcnt, off_lo, off_hi) */
    case SYS_PWRITEV:
        return (long)kernel_pwritev((int32_t)a1,
                                    (const uint8_t *)(uintptr_t)a2,
                                    (int32_t)a3,
                                    (uint32_t)a4, (int32_t)a5);

    /* preadv2/pwritev2 — delegate to preadv/pwritev (ignore flags in a6) */
    case SYS_PREADV2:
        return (long)kernel_preadv((int32_t)a1,
                                   (uint8_t *)(uintptr_t)a2,
                                   (int32_t)a3,
                                   (uint32_t)a4, (int32_t)a5);

    case SYS_PWRITEV2:
        return (long)kernel_pwritev((int32_t)a1,
                                    (const uint8_t *)(uintptr_t)a2,
                                    (int32_t)a3,
                                    (uint32_t)a4, (int32_t)a5);

    /* sendfile — (out_fd, in_fd, offset_ptr, count) */
    case SYS_SENDFILE:
        return (long)kernel_sendfile((int32_t)a1, (int32_t)a2,
                                     (uint8_t *)(uintptr_t)a3,
                                     (uint32_t)a4);

    /* ============================================================== */
    /* statx — extended stat                                           */
    /* ============================================================== */

    case SYS_STATX: {
        const char *p = (const char *)(uintptr_t)a2;
        return (long)kernel_statx((int32_t)a1, (const uint8_t *)p,
                                   slen(p), (uint32_t)a3, (uint32_t)a4,
                                   (uint8_t *)(uintptr_t)a5);
    }

    /* ============================================================== */
    /* Scheduler stubs — single-threaded Wasm defaults                 */
    /* ============================================================== */

    case SYS_SCHED_GETPARAM: {
        /* Write sched_priority=0 to param buf (4 bytes) */
        uint32_t *param = (uint32_t *)(uintptr_t)a2;
        if (param) *param = 0;
        return 0;
    }

    case SYS_SCHED_SETPARAM:
        return 0; /* no-op */

    case SYS_SCHED_GETSCHEDULER:
        return 0; /* SCHED_OTHER */

    case SYS_SCHED_SETSCHEDULER:
        return 0; /* no-op */

    case SYS_SCHED_GET_PRIORITY_MAX:
        return 0;

    case SYS_SCHED_GET_PRIORITY_MIN:
        return 0;

    case SYS_SCHED_RR_GET_INTERVAL: {
        /* Write 10ms timespec to buf: {0 sec, 10000000 nsec} */
        int32_t *ts = (int32_t *)(uintptr_t)a2;
        if (ts) {
            ts[0] = 0;        /* tv_sec */
            ts[1] = 10000000; /* tv_nsec = 10ms */
        }
        return 0;
    }

    case SYS_SCHED_SETAFFINITY:
        return 0; /* no-op */

    case SYS_SCHED_GETAFFINITY: {
        /* Set bit 0 in cpuset (1 CPU), return sizeof(cpuset) */
        uint32_t size = (uint32_t)a2;
        uint8_t *mask = (uint8_t *)(uintptr_t)a3;
        if (mask && size > 0) {
            for (uint32_t i = 0; i < size; i++) mask[i] = 0;
            mask[0] = 1; /* CPU 0 */
        }
        return (long)(size > 0 ? size : 8);
    }

    /* ============================================================== */
    /* Filesystem stubs                                                */
    /* ============================================================== */

    case SYS_SYNC:
    case SYS_SYNCFS:
        return 0; /* no-op */

    case SYS_CHROOT:
    case SYS_MOUNT:
    case SYS_UMOUNT2:
    case SYS_PIVOT_ROOT:
    case SYS_MKNOD:
    case SYS_MKNODAT:
        return -1; /* -EPERM */

    case SYS_QUOTACTL:
        return ENOSYS_NEG;

    /* renameat2 — delegate to renameat (ignore flags in a5) */
    case SYS_RENAMEAT2: {
        const char *oldp = (const char *)(uintptr_t)a2;
        const char *newp = (const char *)(uintptr_t)a4;
        return (long)kernel_renameat((int32_t)a1,
                                     (const uint8_t *)oldp, slen(oldp),
                                     (int32_t)a3,
                                     (const uint8_t *)newp, slen(newp));
    }

    /* faccessat2 — delegate to faccessat (ignore extra flags) */
    case SYS_FACCESSAT2: {
        const char *p = (const char *)(uintptr_t)a2;
        return (long)kernel_faccessat((int32_t)a1, (const uint8_t *)p,
                                      slen(p), (uint32_t)a3, (uint32_t)a4);
    }

    /* fchmodat2 — delegate to fchmodat (ignore extra flags) */
    case SYS_FCHMODAT2: {
        const char *p = (const char *)(uintptr_t)a2;
        return (long)kernel_fchmodat((int32_t)a1, (const uint8_t *)p,
                                     slen(p), (uint32_t)a3, (uint32_t)a4);
    }

    case SYS_FALLOCATE:
        return 0; /* no-op */

    case SYS_COPY_FILE_RANGE:
        return ENOSYS_NEG; /* programs fall back to read+write */

    /* getdents (legacy) — delegate to getdents64 */
    case 141: /* SYS_GETDENTS legacy */
        return (long)kernel_getdents64((int32_t)a1,
                                       (uint8_t *)(uintptr_t)a2,
                                       (uint32_t)a3);

    /* ============================================================== */
    /* Time stubs                                                      */
    /* ============================================================== */

    case SYS_CLOCK_SETTIME:
    case SYS_SETTIMEOFDAY:
    case SYS_ADJTIMEX:
    case SYS_CLOCK_ADJTIME:
        return -1; /* -EPERM */

    /* utimes — convert timeval to timespec, delegate to utimensat */
    case SYS_UTIMES: {
        const char *p = (const char *)(uintptr_t)a1;
        const int32_t *tv = (const int32_t *)(uintptr_t)a2;
        if (!tv) {
            /* NULL times = set to current time */
            return (long)kernel_utimensat(-100, (const uint8_t *)p,
                                          slen(p), (const uint8_t *)0, 0);
        }
        /* Convert 2x timeval {sec,usec} to timespec format for utimensat.
         * musl timeval on wasm32: {long tv_sec, long tv_usec} = 8 bytes each */
        uint8_t ts_buf[32]; /* 2x timespec: {i64 sec, i64 nsec} */
        int64_t atime_sec = (int64_t)tv[0];
        int64_t atime_nsec = (int64_t)tv[1] * 1000;
        int64_t mtime_sec = (int64_t)tv[2];
        int64_t mtime_nsec = (int64_t)tv[3] * 1000;
        __builtin_memcpy(ts_buf + 0, &atime_sec, 8);
        __builtin_memcpy(ts_buf + 8, &atime_nsec, 8);
        __builtin_memcpy(ts_buf + 16, &mtime_sec, 8);
        __builtin_memcpy(ts_buf + 24, &mtime_nsec, 8);
        return (long)kernel_utimensat(-100, (const uint8_t *)p,
                                      slen(p), ts_buf, 0);
    }

    /* futimesat — like utimes but relative to dirfd */
    case SYS_FUTIMESAT: {
        const char *p = (const char *)(uintptr_t)a2;
        const int32_t *tv = (const int32_t *)(uintptr_t)a3;
        if (!tv) {
            return (long)kernel_utimensat((int32_t)a1, (const uint8_t *)p,
                                          slen(p), (const uint8_t *)0, 0);
        }
        uint8_t ts_buf[32];
        int64_t atime_sec = (int64_t)tv[0];
        int64_t atime_nsec = (int64_t)tv[1] * 1000;
        int64_t mtime_sec = (int64_t)tv[2];
        int64_t mtime_nsec = (int64_t)tv[3] * 1000;
        __builtin_memcpy(ts_buf + 0, &atime_sec, 8);
        __builtin_memcpy(ts_buf + 8, &atime_nsec, 8);
        __builtin_memcpy(ts_buf + 16, &mtime_sec, 8);
        __builtin_memcpy(ts_buf + 24, &mtime_nsec, 8);
        return (long)kernel_utimensat((int32_t)a1, (const uint8_t *)p,
                                      slen(p), ts_buf, 0);
    }

    /* ============================================================== */
    /* Process stubs                                                   */
    /* ============================================================== */

    case SYS_FORK:
    case SYS_VFORK:
        return (long)kernel_fork();

    case SYS_CLONE:
        /* Thread-style clone: a1=flags, a2=stack, a3=ptid, a4=tls, a5=ctid
         * (Linux syscall arg order — NOT the same as __clone() wrapper order) */
        return (long)kernel_clone(
            0,                         /* fn — set by __clone override */
            (uint32_t)(uintptr_t)a2,  /* stack */
            (uint32_t)a1,              /* flags */
            0,                         /* arg — set by __clone override */
            (uint32_t)(uintptr_t)a3,  /* ptid */
            (uint32_t)(uintptr_t)a4,  /* tls */
            (uint32_t)(uintptr_t)a5   /* ctid */
        );

    /* execve — delegate to kernel */
    case SYS_EXECVE: {
        const char *p = (const char *)(uintptr_t)a1;
        return (long)kernel_execve((const uint8_t *)p, slen(p));
    }

    /* execveat — extract path, delegate to kernel_execve */
    case SYS_EXECVEAT: {
        const char *p = (const char *)(uintptr_t)a2;
        return (long)kernel_execve((const uint8_t *)p, slen(p));
    }

    /* ============================================================== */
    /* Event/notification stubs                                        */
    /* ============================================================== */

    case SYS_EVENTFD2:
        return (long)kernel_eventfd2((uint32_t)a1, (uint32_t)a2);
    case SYS_EVENTFD:
        return (long)kernel_eventfd2((uint32_t)a1, 0);

    case SYS_SIGNALFD4:
        return (long)kernel_signalfd4((int32_t)a1, (uint32_t)(uintptr_t)a2, (uint32_t)a3, (uint32_t)a4);
    case SYS_SIGNALFD:
        return (long)kernel_signalfd4((int32_t)a1, (uint32_t)(uintptr_t)a2, (uint32_t)a3, 0);

    case SYS_TIMERFD_CREATE:
        return (long)kernel_timerfd_create((uint32_t)a1, (uint32_t)a2);
    case SYS_TIMERFD_SETTIME:
        return (long)kernel_timerfd_settime((int32_t)a1, (uint32_t)a2, (const uint8_t *)(uintptr_t)a3, (uint8_t *)(uintptr_t)a4);
    case SYS_TIMERFD_GETTIME:
        return (long)kernel_timerfd_gettime((int32_t)a1, (uint8_t *)(uintptr_t)a2);

    case SYS_INOTIFY_INIT1:
    case SYS_INOTIFY_INIT:
        return ENOSYS_NEG;
    case SYS_INOTIFY_ADD_WATCH:
    case SYS_INOTIFY_RM_WATCH:
        return -9; /* -EBADF */

    /* Legacy epoll aliases */
    case SYS_EPOLL_CREATE:
        return (long)kernel_epoll_create1(0);
    case SYS_EPOLL_WAIT:
        return (long)kernel_epoll_pwait((int32_t)a1, (uint8_t *)(uintptr_t)a2, (int32_t)a3, (int32_t)a4, 0);

    /* ============================================================== */
    /* SysV IPC — dispatch to kernel imports                           */
    /* ============================================================== */

    case SYS_MSGGET:
        return kernel_ipc_msgget(a1, a2);
    case SYS_MSGSND:
        return kernel_ipc_msgsnd(a1, (int32_t)a2, (int32_t)a3, a4);
    case SYS_MSGRCV:
        return kernel_ipc_msgrcv(a1, (int32_t)a2, (int32_t)a3, a4, a5);
    case SYS_MSGCTL:
        return kernel_ipc_msgctl(a1, a2, (int32_t)a3);
    case SYS_SEMGET:
        return kernel_ipc_semget(a1, a2, a3);
    case SYS_SEMOP:
        return kernel_ipc_semop(a1, (int32_t)a2, a3);
    case SYS_SEMCTL:
        return kernel_ipc_semctl(a1, a2, a3, (int32_t)a4);
    case SYS_SHMGET:
        return kernel_ipc_shmget(a1, (int32_t)a2, a3);
    case SYS_SHMAT:
        return kernel_ipc_shmat(a1, (int32_t)a2, a3);
    case SYS_SHMDT:
        return kernel_ipc_shmdt((int32_t)a1);
    case SYS_SHMCTL:
        return kernel_ipc_shmctl(a1, a2, (int32_t)a3);

    /* POSIX MQ + IPC multiplexer — still ENOSYS */
    case SYS_SEMTIMEDOP:
    case SYS_MQ_OPEN:
    case SYS_MQ_UNLINK:
    case SYS_MQ_TIMEDSEND:
    case SYS_MQ_TIMEDRECEIVE:
    case SYS_MQ_NOTIFY:
    case SYS_MQ_GETSETATTR:
    case SYS_IPC: {
        /* SysV IPC multiplexer — a1 = IPCOP_*, a2-a6 = sub-op args */
        long op = a1;
        switch (op) {
        case 13: /* IPCOP_msgget: (key, flag) */
            return kernel_ipc_msgget(a2, a3);
        case 11: /* IPCOP_msgsnd: (qid, len, flag, msgp) */
            return kernel_ipc_msgsnd(a2, (int32_t)a5, (int32_t)a3, a4);
        case 12: { /* IPCOP_msgrcv: (qid, len, flag, {msgp, type}) */
            /* a5 points to {long msgp; long type} */
            long *pair = (long *)a5;
            return kernel_ipc_msgrcv(a2, (int32_t)pair[0], (int32_t)a3, pair[1], a4);
        }
        case 14: /* IPCOP_msgctl: (qid, cmd, 0, buf) */
            return kernel_ipc_msgctl(a2, a3, (int32_t)a5);
        case 2:  /* IPCOP_semget: (key, nsems, flag) */
            return kernel_ipc_semget(a2, a3, a4);
        case 1:  /* IPCOP_semop: (id, nsops, 0, buf) */
            return kernel_ipc_semop(a2, (int32_t)a5, a3);
        case 3:  /* IPCOP_semctl: (id, num, cmd, &arg) */
            return kernel_ipc_semctl(a2, a3, a4, (int32_t)a5);
        case 23: /* IPCOP_shmget: (key, size, flag) */
            return kernel_ipc_shmget(a2, a3, a4);
        case 21: { /* IPCOP_shmat: (id, flag, &raddr, addr) */
            int32_t addr = kernel_ipc_shmat(a2, (int32_t)a5, a3);
            if (addr < 0) return addr; /* error */
            /* Write result address back through pointer (a4) */
            *(long *)a4 = addr;
            return 0;
        }
        case 22: /* IPCOP_shmdt: (0, 0, 0, addr) */
            return kernel_ipc_shmdt((int32_t)a5);
        case 24: /* IPCOP_shmctl: (id, cmd, 0, buf) */
            return kernel_ipc_shmctl(a2, a3, (int32_t)a5);
        default:
            return ENOSYS_NEG;
        }
    }

    /* ============================================================== */
    /* Extended attributes stubs — all return ENOSYS                   */
    /* ============================================================== */

    case SYS_FGETXATTR:
    case SYS_FLISTXATTR:
    case SYS_FREMOVEXATTR:
    case SYS_FSETXATTR:
    case SYS_GETXATTR:
    case SYS_LISTXATTR:
    case SYS_LGETXATTR:
    case SYS_LLISTXATTR:
    case SYS_LREMOVEXATTR:
    case SYS_LSETXATTR:
    case SYS_REMOVEXATTR:
    case SYS_SETXATTR:
        return ENOSYS_NEG;

    /* ============================================================== */
    /* POSIX timers — all return ENOSYS                                */
    /* ============================================================== */

    case SYS_TIMER_CREATE:
    case SYS_TIMER_SETTIME:
    case SYS_TIMER_GETTIME:
    case SYS_TIMER_GETOVERRUN:
    case SYS_TIMER_DELETE:
        return ENOSYS_NEG;

    /* ============================================================== */
    /* fanotify — return ENOSYS                                        */
    /* ============================================================== */

    case SYS_FANOTIFY_INIT:
    case SYS_FANOTIFY_MARK:
        return ENOSYS_NEG;

    /* ============================================================== */
    /* Remaining stubs                                                 */
    /* ============================================================== */

    case SYS_MEMFD_CREATE:
        return ENOSYS_NEG;

    case SYS_MEMBARRIER:
        return 0; /* no-op, single-threaded */

    case SYS_GETCPU: {
        uint32_t *cpu_ptr = (uint32_t *)(uintptr_t)a1;
        uint32_t *node_ptr = (uint32_t *)(uintptr_t)a2;
        if (cpu_ptr) *cpu_ptr = 0;
        if (node_ptr) *node_ptr = 0;
        return 0;
    }

    case SYS_SENDMMSG:
    case SYS_RECVMMSG:
        return ENOSYS_NEG;

    case SYS_SPLICE:
    case SYS_TEE:
    case SYS_VMSPLICE:
        return ENOSYS_NEG;

    case SYS_READAHEAD:
        return 0; /* no-op advisory */

    case SYS_SYNC_FILE_RANGE:
        return 0; /* no-op */

    case SYS_REMAP_FILE_PAGES:
        return ENOSYS_NEG;

    case SYS_PERSONALITY:
        return 0; /* PER_LINUX */

    case SYS_UNSHARE:
    case SYS_SETNS:
        return -1; /* -EPERM */

    case SYS_NAME_TO_HANDLE_AT:
    case SYS_OPEN_BY_HANDLE_AT:
        return ENOSYS_NEG;

    case SYS_PROCESS_VM_READV:
    case SYS_PROCESS_VM_WRITEV:
        return ENOSYS_NEG;

    case SYS_REBOOT:
    case SYS_SWAPON:
    case SYS_SWAPOFF:
        return -1; /* -EPERM */

    case SYS_ACCT:
    case SYS_PTRACE:
        return ENOSYS_NEG;

    case SYS_SYSLOG:
    case SYS_CAPGET:
    case SYS_CAPSET:
    case SYS_VHANGUP:
    case SYS_SETHOSTNAME:
    case SYS_SETDOMAINNAME:
    case SYS_INIT_MODULE:
    case SYS_DELETE_MODULE:
    case SYS_IOPERM:
    case SYS_IOPL:
        return -1; /* -EPERM */

    case SYS_SETFSUID:
    case SYS_SETFSGID:
        return 0; /* no-op, return current uid/gid */

    case SYS_SET_THREAD_AREA:
        return ENOSYS_NEG;

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
