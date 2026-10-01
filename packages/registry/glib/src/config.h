/* config.h — hand-curated for wasm32-posix-kernel (meson bypass).
 *
 * Every HAVE_* answers "does the wasm musl sysroot provide it AND does
 * the kandelo kernel back it at runtime". Verified against
 * sysroot/include + nm sysroot/lib/libc.a + crates/shared syscall
 * numbers. Deliberate omissions (the libc symbol exists but the
 * fallback path is the proven one on this kernel):
 *
 *   HAVE_POSIX_SPAWN   — gspawn must take fork/exec (fork instrumentation).
 *   HAVE_EVENTFD       — GWakeup uses the pipe2 path.
 *   HAVE_FUTEX         — GMutex/GCond stay on pthreads (musl over kernel futex).
 *   HAVE_SPLICE / HAVE_COPY_FILE_RANGE — no kernel syscall; read/write loop.
 *   HAVE_CLOSE_RANGE / HAVE_FDWALK     — gspawn closes fds by loop.
 *   HAVE_SYS_INOTIFY_H / HAVE_INOTIFY_INIT1 — no inotify syscalls;
 *     gio must not select the inotify file monitor.
 *   HAVE_XATTR         — no *xattr syscalls.
 *   HAVE_RECVMMSG / HAVE_SENDMMSG      — no kernel syscall.
 */

#ifndef GLIB_WASM_CONFIG_H
#define GLIB_WASM_CONFIG_H

#define _GNU_SOURCE 1

#define GETTEXT_PACKAGE "glib20"
#define GLIB_LOCALE_DIR "/usr/share/locale"
#define GLIB_LOCALSTATEDIR "/var"
#define GLIB_RUNSTATEDIR "/run"

#define GLIB_BINARY_AGE 8404
#define GLIB_INTERFACE_AGE 4
#define GLIB_MAJOR_VERSION 2
#define GLIB_MINOR_VERSION 84
#define GLIB_MICRO_VERSION 4
#define GLIB_VERSION "2.84.4"
#define PACKAGE_BUGREPORT "https://gitlab.gnome.org/GNOME/glib/-/issues/new"
#define PACKAGE_NAME "glib"
#define PACKAGE_STRING "glib 2.84.4"
#define PACKAGE_TARNAME "glib"
#define PACKAGE_URL ""
#define PACKAGE_VERSION "2.84.4"

/* Headers present in the wasm musl sysroot. */
#define HAVE_ALLOCA_H 1
#define HAVE_DIRENT_H 1
#define HAVE_FLOAT_H 1
#define HAVE_FTW_H 1
#define HAVE_GRP_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_LIMITS_H 1
#define HAVE_LOCALE_H 1
#define HAVE_MEMORY_H 1
#define HAVE_MNTENT_H 1
#define HAVE_POLL_H 1
#define HAVE_PWD_H 1
#define HAVE_SCHED_H 1
#define HAVE_SPAWN_H 1
#define HAVE_STDATOMIC_H 1
#define HAVE_STDINT_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRING_H 1
#define HAVE_STRINGS_H 1
#define HAVE_SYS_AUXV_H 1
#define HAVE_SYS_MOUNT_H 1
#define HAVE_SYS_PARAM_H 1
#define HAVE_SYS_POLL_H 1
#define HAVE_SYS_PRCTL_H 1
#define HAVE_SYS_RESOURCE_H 1
#define HAVE_SYS_SELECT_H 1
#define HAVE_SYS_STATFS_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_STATVFS_H 1
#define HAVE_SYS_TIME_H 1
#define HAVE_SYS_TIMES_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_SYS_UIO_H 1
#define HAVE_SYS_VFS_H 1
#define HAVE_SYS_WAIT_H 1
#define HAVE_SYSLOG_H 1
#define HAVE_TERMIOS_H 1
#define HAVE_UNISTD_H 1
#define HAVE_VALUES_H 1
#define HAVE_WCHAR_H 1

/* Types and compiler facts (wasm32 ILP32, clang). */
#define HAVE_LONG_LONG 1
#define HAVE_LONG_DOUBLE 1
#define HAVE_WCHAR_T 1
#define HAVE_WINT_T 1
#define HAVE_PTRDIFF_T 1
#define HAVE_SIG_ATOMIC_T 1
#define HAVE_INTMAX_T 1
#define HAVE_STDINT_H_WITH_UINTMAX 1
#define HAVE_INTTYPES_H_WITH_UINTMAX 1
#define HAVE_LOFF_T 1

#define SIZEOF_CHAR 1
#define SIZEOF_SHORT 2
#define SIZEOF_INT 4
#define SIZEOF_LONG 4
#define SIZEOF_LONG_LONG 8
#define SIZEOF_SIZE_T 4
#define SIZEOF_SSIZE_T 4
#define SIZEOF_VOID_P 4
#define SIZEOF_WCHAR_T 4

#define ALIGNOF_GUINT32 4
#define ALIGNOF_GUINT64 8
#define ALIGNOF_UNSIGNED_LONG 4

/* printf family: musl is C99-conformant, glib wraps the system printf.
 * USE_SYSTEM_PRINTF is the gprintfint.h switch — without it every
 * g_*printf routes to the gnulib fallback, which this port does not
 * compile, and `-Wl,--allow-undefined` turns those into null table
 * entries that trap at the first g_snprintf. */
#define USE_SYSTEM_PRINTF 1
#define HAVE_C99_SNPRINTF 1
#define HAVE_C99_VSNPRINTF 1
#define HAVE_SNPRINTF 1
#define HAVE_VSNPRINTF 1
#define HAVE_VASPRINTF 1
#define HAVE_UNIX98_PRINTF 1

/* Functions in the sysroot libc, kernel-backed. */
#define HAVE_ACCEPT4 1
#define HAVE_ALIGNED_ALLOC 1
#define HAVE_EPOLL_CREATE1 1
#define HAVE_FACCESSAT 1
#define HAVE_FALLOCATE 1
#define HAVE_FCHMOD 1
#define HAVE_FCHOWN 1
#define HAVE_FSYNC 1
#define HAVE_GETAUXVAL 1
#define HAVE_GETC_UNLOCKED 1
#define HAVE_GETGRGID_R 1
#define HAVE_GETMNTENT_R 1
#define HAVE_GETPWUID_R 1
#define HAVE_GETRESUID 1
#define HAVE_GMTIME_R 1
#define HAVE_HASMNTOPT 1
#define HAVE_ENDMNTENT 1
#define HAVE_SETMNTENT 1
#define HAVE_LCHOWN 1
#define HAVE_LINK 1
#define HAVE_LOCALTIME_R 1
#define HAVE_LSTAT 1
#define HAVE_MBRTOWC 1
#define HAVE_MEMALIGN 1
#define HAVE_MEMMEM 1
#define HAVE_MKOSTEMP 1
#define HAVE_MMAP 1
#define HAVE_NEWLOCALE 1
#define HAVE_OPEN_O_DIRECTORY 1
#define HAVE_PIPE2 1
#define HAVE_POLL 1
#define HAVE_POSIX_MEMALIGN 1
#define HAVE_PPOLL 1
#define HAVE_PRCTL 1
#define HAVE_PRLIMIT 1
#define HAVE_READLINK 1
#define HAVE_SETENV 1
#define HAVE_STPCPY 1
#define HAVE_STRCASECMP 1
#define HAVE_STRERROR_R 1
#define HAVE_STRLCPY 1
#define HAVE_STRNCASECMP 1
#define HAVE_STRNLEN 1
#define HAVE_STRSIGNAL 1
#define HAVE_STRTOD_L 1
#define HAVE_SYMLINK 1
#define HAVE_TIMEGM 1
#define HAVE_UNSETENV 1
#define HAVE_USELOCALE 1
#define HAVE_UTIMES 1
#define HAVE_UTIMENSAT 1
#define HAVE_VALLOC 1
#define HAVE_WCRTOMB 1
#define HAVE_WCSLEN 1
#define HAVE_WCSNLEN 1
#define HAVE_STATFS 1
#define HAVE_STATVFS 1
#define STATFS_ARGS 2
#define USE_STATFS 1

/* Threads: POSIX over musl pthreads (kernel clone/futex). */
#define THREADS_POSIX 1
#define HAVE_PTHREAD_ATTR_SETSTACKSIZE 1
#define HAVE_PTHREAD_ATTR_SETINHERITSCHED 1
#define HAVE_PTHREAD_CONDATTR_SETCLOCK 1
#define HAVE_PTHREAD_GETNAME_NP 1
#define HAVE_PTHREAD_SETNAME_NP_WITH_TID 1
#define HAVE_PTHREAD_GETAFFINITY_NP 1

#define HAVE_CLOCK_GETTIME 1

/* dlopen constants (musl dlfcn.h; kandelo supports dlopen). */
#define HAVE_RTLD_GLOBAL 1
#define HAVE_RTLD_LAZY 1
#define HAVE_RTLD_NOW 1
#define HAVE_RTLD_NEXT 1

/* locale / gettext: musl nl_langinfo + built-in gettext stubs. */
#define ENABLE_NLS 1
#define HAVE_CODESET 1
#define HAVE_LANGINFO_CODESET 1
#define HAVE_LANGINFO_TIME 1
#define HAVE_LC_MESSAGES 1
#define HAVE_GETTEXT 1
#define HAVE_DCGETTEXT 1
#define HAVE_BIND_TEXTDOMAIN_CODESET 1

/* struct members (musl definitions). */
#define HAVE_STRUCT_STAT_ST_MTIM_TV_NSEC 1
#define HAVE_STRUCT_STAT_ST_ATIM_TV_NSEC 1
#define HAVE_STRUCT_STAT_ST_CTIM_TV_NSEC 1
#define HAVE_STRUCT_STAT_ST_BLKSIZE 1
#define HAVE_STRUCT_STAT_ST_BLOCKS 1
#define HAVE_STRUCT_STATFS_F_BAVAIL 1
#define HAVE_STRUCT_STATVFS_F_TYPE 1
#define HAVE_STRUCT_DIRENT_D_TYPE 1
#define HAVE_STRUCT_TM_TM_GMTOFF 1

#define HAVE_IPV6 1

#endif /* GLIB_WASM_CONFIG_H */
