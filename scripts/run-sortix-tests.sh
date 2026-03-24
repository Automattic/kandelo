#!/bin/bash
set -euo pipefail

# Build and run Sortix os-test conformance tests against the wasm-posix-kernel.
#
# Suites:
#   include  — Header declaration existence + type correctness (~3741 tests)
#   limits   — POSIX limits.h constant validation (~46 tests)
#   basic    — Function invocation smoke tests (~933 tests)
#   malloc   — Memory allocation edge cases (3 tests)
#   stdio    — printf formatting tests (7 tests)
#   io       — I/O syscall behavior (~55 tests)
#   signal   — Signal behavior (~32 tests)
#   process  — Process management (~24 tests)
#   paths    — Filesystem path existence (~48 tests)
#
# Usage:
#   scripts/run-sortix-tests.sh                       # run default suites (include limits basic malloc stdio)
#   scripts/run-sortix-tests.sh include               # run one suite
#   scripts/run-sortix-tests.sh basic stdio/printf     # run suite or specific test
#   scripts/run-sortix-tests.sh --all                 # run all suites
#   scripts/run-sortix-tests.sh --report              # run all + write report

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSROOT="$REPO_ROOT/sysroot"
GLUE_DIR="$REPO_ROOT/glue"
OS_TEST="$REPO_ROOT/os-test"
BUILD_DIR="$REPO_ROOT/os-test/build"
KERNEL_WASM="$REPO_ROOT/host/wasm/wasm_posix_kernel.wasm"

# ── Expected failures ──────────────────────────────────────
# Include tests for headers/features our musl sysroot doesn't provide.
# Format: "header/symbol" matching the test path under os-test/include/
INCLUDE_EXPECTED_FAIL=(
    # POSIX.1-2024 additions not yet in musl (musl targets POSIX.1-2008)
    # -- O_CLOFORK and related close-on-fork flags
    "fcntl/F_DUPFD_CLOFORK" "fcntl/FD_CLOFORK" "fcntl/O_CLOFORK"
    "stdlib/O_CLOFORK" "sys_mman/O_CLOFORK" "sys_socket/MSG_CMSG_CLOFORK"
    "sys_socket/SOCK_CLOFORK" "unistd/O_CLOFORK"
    # -- O_* flags re-exported in stdlib.h, sys/mman.h, unistd.h (2024 requirement)
    "stdlib/O_APPEND" "stdlib/O_CLOEXEC" "stdlib/O_DSYNC" "stdlib/O_NOCTTY"
    "stdlib/O_RDWR" "stdlib/O_RSYNC" "stdlib/O_SYNC"
    "sys_mman/O_CLOEXEC" "sys_mman/O_CREAT" "sys_mman/O_EXCL"
    "sys_mman/O_RDONLY" "sys_mman/O_RDWR" "sys_mman/O_TRUNC" "sys_mman/O_WRONLY"
    "unistd/O_CLOEXEC"
    # -- New dirent API (posix_getdents, posix_dent, DT_MQ/SEM/SHM/TMO)
    "dirent/DT_MQ" "dirent/DT_SEM" "dirent/DT_SHM" "dirent/DT_TMO"
    "dirent/posix_getdents" "dirent/reclen_t" "dirent/ssize_t"
    "dirent/struct-posix_dent" "dirent/struct-posix_dent-d_ino"
    "dirent/struct-posix_dent-d_name" "dirent/struct-posix_dent-d_reclen"
    "dirent/struct-posix_dent-d_type"
    "sys_types/reclen_t"
    # -- Alternate month names (langinfo)
    "langinfo/ABALTMON_1" "langinfo/ABALTMON_2" "langinfo/ABALTMON_3"
    "langinfo/ABALTMON_4" "langinfo/ABALTMON_5" "langinfo/ABALTMON_6"
    "langinfo/ABALTMON_7" "langinfo/ABALTMON_8" "langinfo/ABALTMON_9"
    "langinfo/ABALTMON_10" "langinfo/ABALTMON_11" "langinfo/ABALTMON_12"
    "langinfo/ALTMON_1" "langinfo/ALTMON_2" "langinfo/ALTMON_3"
    "langinfo/ALTMON_4" "langinfo/ALTMON_5" "langinfo/ALTMON_6"
    "langinfo/ALTMON_7" "langinfo/ALTMON_8" "langinfo/ALTMON_9"
    "langinfo/ALTMON_10" "langinfo/ALTMON_11" "langinfo/ALTMON_12"
    # -- New math constants (long double variants, golden ratio, etc.)
    "math/M_1_PIl" "math/M_1_SQRTPI" "math/M_1_SQRTPIl" "math/M_2_PIl"
    "math/M_2_SQRTPIl" "math/M_EGAMMA" "math/M_EGAMMAl" "math/M_El"
    "math/M_LN10l" "math/M_LN2l" "math/M_LOG10El" "math/M_LOG2El"
    "math/M_PHI" "math/M_PHIl" "math/M_PI_2l" "math/M_PI_4l" "math/M_PIl"
    "math/M_SQRT1_2l" "math/M_SQRT1_3" "math/M_SQRT1_3l" "math/M_SQRT2l"
    "math/M_SQRT3" "math/M_SQRT3l"
    # -- Clock-aware pthread/semaphore waits
    "pthread/pthread_cond_clockwait" "pthread/pthread_mutex_clocklock"
    "pthread/pthread_rwlock_clockrdlock" "pthread/pthread_rwlock_clockwrlock"
    "semaphore/sem_clockwait"
    # -- Signal name/number conversion
    "signal/sig2str" "signal/SIG2STR_MAX" "signal/str2sig"
    # -- Updated tsearch/tdelete/tfind/twalk signatures
    "search/posix_tnode" "search/tdelete" "search/tfind" "search/tsearch" "search/twalk"
    # -- New spawn actions
    "spawn/posix_spawn_file_actions_addchdir" "spawn/posix_spawn_file_actions_addfchdir"
    # -- New regex/fnmatch/ftw flags
    "regex/REG_MINIMAL" "fnmatch/FNM_IGNORECASE" "ftw/FTW_XDEV"
    # -- New limits
    "limits/GETENTROPY_MAX" "limits/NSIG_MAX"
    # -- New locale function
    "locale/getlocalename_l"
    # -- V8 confstr/sysconf (POSIX.1-2024 issue 8)
    "unistd/_CS_POSIX_V8_ILP32_OFF32_CFLAGS" "unistd/_CS_POSIX_V8_ILP32_OFF32_LDFLAGS"
    "unistd/_CS_POSIX_V8_ILP32_OFF32_LIBS" "unistd/_CS_POSIX_V8_ILP32_OFFBIG_CFLAGS"
    "unistd/_CS_POSIX_V8_ILP32_OFFBIG_LDFLAGS" "unistd/_CS_POSIX_V8_ILP32_OFFBIG_LIBS"
    "unistd/_CS_POSIX_V8_LP64_OFF64_CFLAGS" "unistd/_CS_POSIX_V8_LP64_OFF64_LDFLAGS"
    "unistd/_CS_POSIX_V8_LP64_OFF64_LIBS" "unistd/_CS_POSIX_V8_LPBIG_OFFBIG_CFLAGS"
    "unistd/_CS_POSIX_V8_LPBIG_OFFBIG_LDFLAGS" "unistd/_CS_POSIX_V8_LPBIG_OFFBIG_LIBS"
    "unistd/_CS_POSIX_V8_THREADS_CFLAGS" "unistd/_CS_POSIX_V8_THREADS_LDFLAGS"
    "unistd/_CS_POSIX_V8_WIDTH_RESTRICTED_ENVS" "unistd/_CS_V8_ENV"
    "unistd/_SC_V8_ILP32_OFF32" "unistd/_SC_V8_ILP32_OFFBIG"
    "unistd/_SC_V8_LP64_OFF64" "unistd/_SC_V8_LPBIG_OFFBIG"
    # -- New pathconf values
    "unistd/_PC_FALLOC" "unistd/_PC_TEXTDOMAIN_MAX" "unistd/_PC_TIMESTAMP_RESOLUTION"
    # -- Feature test macros for unimplemented optional features
    "unistd/_POSIX_DEVICE_CONTROL" "unistd/_POSIX_PRIORITIZED_IO"
    "unistd/_POSIX_PRIORITY_SCHEDULING" "unistd/_POSIX_SPORADIC_SERVER"
    "unistd/_POSIX_SYNCHRONIZED_IO" "unistd/_POSIX_THREAD_PRIO_INHERIT"
    "unistd/_POSIX_THREAD_PRIO_PROTECT" "unistd/_POSIX_THREAD_ROBUST_PRIO_INHERIT"
    "unistd/_POSIX_THREAD_ROBUST_PRIO_PROTECT" "unistd/_POSIX_THREAD_SPORADIC_SERVER"
    "unistd/_POSIX_TYPED_MEMORY_OBJECTS"
    "unistd/_POSIX2_C_DEV" "unistd/_POSIX2_FORT_RUN" "unistd/_POSIX2_SW_DEV" "unistd/_POSIX2_UPE"
    "unistd/_SC_DEVICE_CONTROL" "unistd/_SC_NSIG" "unistd/_SC_XOPEN_UUCP"
    "unistd/_XOPEN_CRYPT" "unistd/_XOPEN_REALTIME" "unistd/_XOPEN_REALTIME_THREADS"
    "unistd/_XOPEN_SHM" "unistd/_XOPEN_UUCP"
    # -- BSD string functions added in 2024
    "wchar/wcslcat" "wchar/wcslcpy"
    # -- Headers/features not in musl
    "devctl/posix_devctl" "devctl/size_t"      # device control (Sortix/2024)
    "libintl/dcgettext_l" "libintl/dcngettext_l" "libintl/dgettext_l"
    "libintl/dngettext_l" "libintl/gettext_l" "libintl/locale_t" "libintl/ngettext_l"
    "ndbm/datum" "ndbm/datum-dptr" "ndbm/datum-dsize" "ndbm/DBM"
    "ndbm/dbm_clearerr" "ndbm/dbm_close" "ndbm/dbm_delete" "ndbm/dbm_error"
    "ndbm/dbm_fetch" "ndbm/dbm_firstkey" "ndbm/DBM_INSERT" "ndbm/dbm_nextkey"
    "ndbm/dbm_open" "ndbm/DBM_REPLACE" "ndbm/dbm_store" "ndbm/mode_t" "ndbm/size_t"
    "dlfcn/Dl_info_t" "dlfcn/Dl_info_t-dli_fbase" "dlfcn/Dl_info_t-dli_fname"
    "dlfcn/Dl_info_t-dli_saddr" "dlfcn/Dl_info_t-dli_sname" "dlfcn/dladdr"
    "sched/SCHED_SPORADIC" "sched/struct-sched_param-sched_ss_init_budget"
    "sched/struct-sched_param-sched_ss_low_priority"
    "sched/struct-sched_param-sched_ss_max_repl"
    "sched/struct-sched_param-sched_ss_repl_period"
    # -- Typed memory objects (not in musl)
    "sys_mman/posix_mem_offset" "sys_mman/POSIX_TYPED_MEM_ALLOCATE"
    "sys_mman/POSIX_TYPED_MEM_ALLOCATE_CONTIG" "sys_mman/posix_typed_mem_get_info"
    "sys_mman/POSIX_TYPED_MEM_MAP_ALLOCATABLE" "sys_mman/posix_typed_mem_open"
    "sys_mman/struct-posix_typed_mem_info" "sys_mman/struct-posix_typed_mem_info-posix_tmi_length"
    # -- mqueue O_* flags (mqueue.h doesn't re-export these in musl)
    "mqueue/O_CREAT" "mqueue/O_EXCL" "mqueue/O_NONBLOCK" "mqueue/O_RDONLY"
    "mqueue/O_RDWR" "mqueue/O_WRONLY"
    # -- sys/shm.h missing symbols
    "sys_shm/intptr_t" "sys_shm/SHM_FAILED"
    # -- sys/stat struct member type issue
    "sys_stat/struct-stat-st_size"
    # -- siglongjmp (Wasm limitation)
    "setjmp/siglongjmp"
)

BASIC_EXPECTED_FAIL=(
    # -- Headers/libraries not available in musl or Wasm
    "devctl/posix_devctl"                                 # device control (2024)
    "libintl/bindtextdomain" "libintl/dcgettext_l" "libintl/dcngettext_l"
    "libintl/dgettext_l" "libintl/dngettext_l" "libintl/gettext_l" "libintl/ngettext_l"
    "ndbm/dbm_clearerr" "ndbm/dbm_close" "ndbm/dbm_delete" "ndbm/dbm_error"
    "ndbm/dbm_fetch" "ndbm/dbm_firstkey" "ndbm/dbm_nextkey" "ndbm/dbm_open" "ndbm/dbm_store"
    "nl_types/catclose" "nl_types/catgets" "nl_types/catopen"
    "utmpx/pututxline"
    "mqueue/mq_close" "mqueue/mq_getattr" "mqueue/mq_notify" "mqueue/mq_open"
    "mqueue/mq_receive" "mqueue/mq_send" "mqueue/mq_setattr"
    "mqueue/mq_timedreceive" "mqueue/mq_timedsend" "mqueue/mq_unlink"
    # -- Dynamic linking (not supported in Wasm)
    "dlfcn/dladdr" "dlfcn/dlclose" "dlfcn/dlopen" "dlfcn/dlsym"
    # -- setjmp/longjmp (Wasm exception handling limitations)
    "setjmp/longjmp" "setjmp/setjmp" "setjmp/siglongjmp" "setjmp/sigsetjmp"
    # -- Process exec (not implemented in centralized mode)
    "unistd/execl" "unistd/execle" "unistd/execlp" "unistd/execv"
    "unistd/execve" "unistd/execvp" "unistd/fexecve"
    # -- Memory locking (mlock/munlock are stubs; mlockall/munlockall work)
    # (mlock, mlockall, munlock, munlockall removed — stubs pass basic invocation tests)
    # -- Privileged operations
    "time/clock_settime" "unistd/fchownat" "unistd/lchown"
    # -- Process management requiring fork/exec or process groups
    "sys_wait/waitpid"
    "unistd/setregid" "unistd/setreuid"
    "stdlib/abort" "stdlib/system"
    # -- Signals (limited Wasm signal model)
    "signal/kill" "signal/killpg"
    "signal/sig2str" "signal/sigaltstack"
    "signal/str2sig"
    # -- Timers/signals that block (timeout)
    "aio/aio_error" "aio/aio_fsync" "aio/aio_read"
    "poll/ppoll"
    "pthread/pthread_barrierattr_setpshared" "pthread/pthread_cancel"
    "pthread/pthread_cleanup_pop" "pthread/pthread_cleanup_push"
    "pthread/pthread_condattr_setpshared"
    "pthread/pthread_create"
    "signal/pthread_kill"
    "threads/thrd_create"
    "unistd/pause" "unistd/alarm"
    # -- Pthread features not supported (priority scheduling, pshared)
    "pthread/pthread_atfork" "pthread/pthread_attr_getstack"
    "pthread/pthread_attr_setinheritsched"
    "pthread/pthread_cond_clockwait"
    "pthread/pthread_mutex_clocklock"
    "pthread/pthread_mutex_getprioceiling" "pthread/pthread_mutex_setprioceiling"
    "pthread/pthread_mutexattr_getprioceiling" "pthread/pthread_mutexattr_setprioceiling"
    "pthread/pthread_mutexattr_setpshared" "pthread/pthread_rwlock_clockrdlock"
    "pthread/pthread_rwlock_clockwrlock"
    "pthread/pthread_setcancelstate"
    # -- Scheduler (sched_yield is a no-op stub; others have basic stubs)
    "sched/sched_yield"
    # -- Semaphore named (not supported in Wasm)
    "semaphore/sem_clockwait" "semaphore/sem_close" "semaphore/sem_open" "semaphore/sem_unlink"
    # -- Terminal I/O (no terminal device in Wasm)
    "termios/tcdrain" "termios/tcflow" "termios/tcflush" "termios/tcgetattr"
    "termios/tcgetsid" "termios/tcgetwinsize" "termios/tcsendbreak"
    "termios/tcsetattr" "termios/tcsetwinsize"
    "unistd/tcgetpgrp" "unistd/tcsetpgrp" "unistd/ttyname" "unistd/ttyname_r"
    "stdlib/ptsname" "stdlib/ptsname_r" "stdlib/unlockpt"
    # -- SysV IPC (not wired in centralized mode)
    "sys_ipc/ftok"
    "sys_msg/msgctl" "sys_msg/msgget" "sys_msg/msgrcv" "sys_msg/msgsnd"
    "sys_sem/semctl" "sys_sem/semget" "sys_sem/semop"
    "sys_shm/shmat" "sys_shm/shmctl" "sys_shm/shmdt" "sys_shm/shmget"
    # -- Socket operations (test tries actual connect/send/recv)
    "sys_socket/accept" "sys_socket/accept4" "sys_socket/connect"
    "sys_socket/getpeername" "sys_socket/getsockopt" "sys_socket/recv"
    "sys_socket/recvfrom" "sys_socket/recvmsg" "sys_socket/send"
    "sys_socket/sendmsg" "sys_socket/sendto" "sys_socket/setsockopt"
    "sys_socket/shutdown" "sys_socket/sockatmark"
    # -- Network interface (not available in Wasm)
    "net_if/if_freenameindex" "net_if/if_indextoname" "net_if/if_nameindex" "net_if/if_nametoindex"
    "netdb/freeaddrinfo" "netdb/getaddrinfo"
    "arpa_inet/inet_ntop"
    # -- Filesystem-dependent tests (test opens files, needs real FS paths)
    "fcntl/open" "fcntl/openat" "fcntl/posix_fadvise" "fcntl/posix_fallocate"
    "dirent/fdopendir" "dirent/posix_getdents" "dirent/readdir" "dirent/readdir_r"
    "dirent/rewinddir" "dirent/scandir" "dirent/seekdir"
    "stdio/fopen" "stdio/pclose" "stdio/popen" "stdio/remove"
    "unistd/faccessat"
    "unistd/lseek" "unistd/read" "unistd/readlinkat"
    "ftw/nftw" "glob/glob" "glob/globfree"
    "wordexp/wordexp" "wordexp/wordfree"
    "sys_stat/fchmodat" "sys_stat/fstat" "sys_stat/fstatat" "sys_stat/futimens"
    "sys_stat/lstat" "sys_stat/mkfifo" "sys_stat/mkfifoat" "sys_stat/mknod"
    "sys_stat/mknodat" "sys_stat/stat"
    "sys_statvfs/fstatvfs"
    "sys_mman/msync" "sys_mman/posix_mem_offset" "sys_mman/posix_typed_mem_get_info"
    "sys_mman/posix_typed_mem_open" "sys_mman/shm_open"
    # -- User/group database (not available in Wasm)
    "pwd/endpwent" "pwd/getpwent" "pwd/getpwnam" "pwd/getpwnam_r"
    "pwd/getpwuid" "pwd/getpwuid_r" "pwd/setpwent"
    "grp/endgrent" "grp/getgrent" "grp/getgrgid" "grp/getgrgid_r"
    "grp/getgrnam" "grp/getgrnam_r" "grp/setgrent"
    # -- Misc not supported
    "time/clock_getcpuclockid"
    "time/timer_create" "time/timer_delete" "time/timer_getoverrun"
    "time/timer_gettime" "time/timer_settime"
    "sys_select/pselect" "sys_select/select" "sys_time/select"
    "locale/getlocalename_l"
    "monetary/strfmon" "monetary/strfmon_l"
    "syslog/closelog" "syslog/syslog"
    "strings/ffsll"
    "wchar/swprintf" "wchar/wcslcat" "wchar/wcslcpy"
    # -- posix_spawn (not implemented in centralized mode)
    "spawn/posix_spawn" "spawn/posix_spawnp"
    "spawn/posix_spawn_file_actions_addchdir" "spawn/posix_spawn_file_actions_addclose"
    "spawn/posix_spawn_file_actions_adddup2" "spawn/posix_spawn_file_actions_addfchdir"
    "spawn/posix_spawn_file_actions_addopen" "spawn/posix_spawn_file_actions_init"
    "spawn/posix_spawnattr_getschedparam" "spawn/posix_spawnattr_getschedpolicy"
    "spawn/posix_spawnattr_setflags" "spawn/posix_spawnattr_setpgroup"
    "spawn/posix_spawnattr_setschedparam" "spawn/posix_spawnattr_setschedpolicy"
    "spawn/posix_spawnattr_setsigdefault" "spawn/posix_spawnattr_setsigmask"
)

LIMITS_EXPECTED_FAIL=()

MALLOC_EXPECTED_FAIL=()

STDIO_EXPECTED_FAIL=()

IO_EXPECTED_FAIL=(
    # OFD locks require fork() for cross-process testing
    "ofd-*"
    # O_CLOFORK is POSIX.1-2024; not in musl
    "dup3-clofork-fork" "open-clofork-fork"
    # open() on existing directory with O_CREAT should return EISDIR
    "open-tmpdir-rdonly-creat"
)

SIGNAL_EXPECTED_FAIL=(
    # Tests requiring exec (not implemented in centralized mode)
    "default-chld-exec" "default-usr1-exec"
    "handle-chld-exec" "handle-usr1-exec"
    "ignore-chld-exec" "ignore-usr1-exec"
    "sigaction-exec-flags" "sigaltstack-exec" "sigaltstack-raise-exec"
    # sigaltstack not implemented in Wasm (no native stack switching)
    "sigaltstack-raise"
    # ppoll + signal mask atomicity (depends on signal delivery)
    "ppoll-*"
)
PROCESS_EXPECTED_FAIL=(
    # Process groups: setpgid undo/redo and cross-process not implemented
    "fork-setpgid-another-*"
    "fork-setpgid-undo*"
    "fork-setsid*"
    "limbo-getpgid" "zombie-getpgid" "zombie-setpgid*"
    # waitpid with PGID (requires process groups)
    "waitpid-pgid*"
    # exec not implemented in centralized mode
    "fork-exec-*"
)
PATHS_EXPECTED_FAIL=()

# ── Helper: check if a test matches an expected-failure pattern ──

is_expected_fail() {
    local test_name="$1"
    shift
    local list=("$@")
    for pattern in "${list[@]}"; do
        # Exact match
        [ "$pattern" = "$test_name" ] && return 0
        # Wildcard match
        if [[ "$pattern" == *"*"* ]]; then
            # shellcheck disable=SC2254
            case "$test_name" in
                $pattern) return 0 ;;
            esac
        fi
    done
    return 1
}

# ── LLVM detection (same as other scripts) ──

find_llvm_bin() {
    if [ -n "${LLVM_BIN:-}" ]; then echo "$LLVM_BIN"; return; fi
    local brew_prefix
    if brew_prefix=$(brew --prefix llvm 2>/dev/null) && [ -d "$brew_prefix/bin" ]; then
        echo "$brew_prefix/bin"; return
    fi
    for v in 21 20 19 18 17 16 15; do
        if [ -x "/usr/bin/clang-$v" ]; then echo "/usr/bin"; return; fi
    done
    if command -v clang >/dev/null 2>&1; then echo "$(dirname "$(command -v clang)")"; return; fi
    echo "Error: LLVM/clang not found." >&2; exit 1
}

LLVM_BIN="$(find_llvm_bin)"
CC="$LLVM_BIN/clang"

# ── Compile flags ──

CFLAGS_BASE=(
    --target=wasm32-unknown-unknown
    --sysroot="$SYSROOT"
    -nostdlib
    -O2
    -matomics -mbulk-memory
    -fno-trapping-math
    -mllvm -wasm-enable-sjlj
    -mllvm -wasm-use-legacy-eh=false
)

LINK_FLAGS=(
    "$GLUE_DIR/channel_syscall.c"
    "$GLUE_DIR/compiler_rt.c"
    "$SYSROOT/lib/crt1.o"
    "$SYSROOT/lib/libc.a"
    -Wl,--entry=_start
    -Wl,--export=_start
    -Wl,--import-memory
    -Wl,--shared-memory
    -Wl,--max-memory=1073741824
    -Wl,--allow-undefined
    -Wl,--table-base=3
    -Wl,--export-table
    -Wl,--export=__wasm_init_tls
    -Wl,--export=__tls_base
    -Wl,--export=__tls_size
    -Wl,--export=__tls_align
    -Wl,--export=__stack_pointer
    -Wl,--export=__wasm_thread_init
)

WASM_OPT="$(command -v wasm-opt 2>/dev/null || true)"
ASYNCIFY_IMPORTS="kernel.kernel_fork"

asyncify_wasm() {
    local wasm="$1"
    if [ -n "$WASM_OPT" ]; then
        "$WASM_OPT" --asyncify \
            --pass-arg="asyncify-imports@${ASYNCIFY_IMPORTS}" \
            "$wasm" -o "$wasm" 2>/dev/null || true
    fi
}

TEST_TIMEOUT=${TEST_TIMEOUT:-30}

# ── Test discovery ──────────────────────────────────────────

# Discover include tests: os-test/include/<header>/<symbol>.c
discover_include() {
    find "$OS_TEST/include" -name "*.c" -type f | sort | while read -r f; do
        # Path relative to os-test/include, e.g. "unistd/read"
        local rel="${f#$OS_TEST/include/}"
        echo "${rel%.c}"
    done
}

# Discover basic tests: os-test/basic/<header>/<func>.c
discover_basic() {
    find "$OS_TEST/basic" -name "*.c" -type f ! -name "basic.h" | sort | while read -r f; do
        local rel="${f#$OS_TEST/basic/}"
        echo "${rel%.c}"
    done
}

# Discover limits tests: os-test/limits/<constant>.c
discover_limits() {
    find "$OS_TEST/limits" -name "*.c" -type f ! -name "suite.h" | sort | while read -r f; do
        local rel="${f#$OS_TEST/limits/}"
        echo "${rel%.c}"
    done
}

# Generic discovery for flat suites (malloc, stdio, io, signal, process, paths)
discover_suite() {
    local suite="$1"
    find "$OS_TEST/$suite" -name "*.c" -type f | sort | while read -r f; do
        local rel="${f#$OS_TEST/$suite/}"
        echo "${rel%.c}"
    done
}

discover_malloc()  { discover_suite malloc; }
discover_stdio()   { discover_suite stdio; }
discover_io()      { discover_suite io; }
discover_signal()  { discover_suite signal; }
discover_process() { discover_suite process; }
discover_paths()   { discover_suite paths; }

# ── Build helpers ───────────────────────────────────────────

# Include tests: compile-only (successful compilation = PASS)
# Uses progressive feature macro fallback like Sortix's try-compile.sh.
# For parallel execution, this writes result to $BUILD_DIR/include/<test>.result
build_include_one() {
    local test_name="$1"   # e.g. "unistd/read"
    local src="$OS_TEST/include/${test_name}.c"
    local wasm="$BUILD_DIR/include/${test_name}.wasm"
    local result_file="$BUILD_DIR/include/${test_name}.result"
    mkdir -p "$(dirname "$wasm")"

    local -a cflags=("${CFLAGS_BASE[@]}" -Wall -Wextra -Werror
        -Wno-error=deprecated -Wno-error=deprecated-declarations
        -I"$OS_TEST")

    # Try _POSIX_C_SOURCE=202405L first (POSIX.1-2024)
    if "$CC" "${cflags[@]}" -D_POSIX_C_SOURCE=202405L \
        "$src" "${LINK_FLAGS[@]}" -o "$wasm" 2>/dev/null; then
        echo "good" > "$result_file"
        rm -f "$wasm"
        return 0
    fi
    # Try _POSIX_C_SOURCE=200809L (POSIX.1-2008)
    if "$CC" "${cflags[@]}" -D_POSIX_C_SOURCE=200809L \
        "$src" "${LINK_FLAGS[@]}" -o "$wasm" 2>/dev/null; then
        echo "previous_posix" > "$result_file"
        rm -f "$wasm"
        return 0
    fi
    # Try GNU/BSD extensions
    if "$CC" "${cflags[@]}" -D_GNU_SOURCE -D_BSD_SOURCE -D_ALL_SOURCE -D_DEFAULT_SOURCE \
        "$src" "${LINK_FLAGS[@]}" -o "$wasm" 2>/dev/null; then
        echo "extension" > "$result_file"
        rm -f "$wasm"
        return 0
    fi

    # Classify the failure
    local err_file="$BUILD_DIR/include/${test_name}.err"
    "$CC" "${cflags[@]}" -D_POSIX_C_SOURCE=202405L \
        "$src" "${LINK_FLAGS[@]}" -o "$wasm" 2>"$err_file" || true

    if grep -q '/\*optional\*/' "$src" 2>/dev/null; then
        echo "missing_optional" > "$result_file"
    elif grep -Eq 'fatal error' "$err_file"; then
        echo "missing_header" > "$result_file"
    elif grep -Eq 'incompatible|pointer-sign' "$err_file"; then
        echo "incompatible" > "$result_file"
    elif grep -Eq 'undeclared|no member named|is not defined' "$err_file"; then
        echo "undeclared" > "$result_file"
    elif grep -Eq 'unknown type name|storage size of|expected declaration specifiers' "$err_file"; then
        echo "unknown_type" > "$result_file"
    elif grep -Eq 'undefined symbol' "$err_file"; then
        echo "undefined" > "$result_file"
    else
        echo "compile_error" > "$result_file"
    fi
    rm -f "$wasm"
    return 0
}
export -f build_include_one

# Basic/limits/malloc/stdio tests: compile and run
build_runtime_test() {
    local suite="$1"
    local test_name="$2"
    local src="$OS_TEST/$suite/${test_name}.c"
    local wasm="$BUILD_DIR/$suite/${test_name}.wasm"
    mkdir -p "$(dirname "$wasm")"

    local -a cflags=("${CFLAGS_BASE[@]}" -D_GNU_SOURCE -I"$OS_TEST")

    "$CC" "${cflags[@]}" \
        "$src" "${LINK_FLAGS[@]}" \
        -o "$wasm" 2>/tmp/sortix-build-err.txt
    asyncify_wasm "$wasm"
}

build_basic()   { build_runtime_test basic "$1"; }
build_limits()  { build_runtime_test limits "$1"; }
build_malloc()  { build_runtime_test malloc "$1"; }
build_stdio()   { build_runtime_test stdio "$1"; }
build_io()      { build_runtime_test io "$1"; }
build_signal()  { build_runtime_test signal "$1"; }
build_process() { build_runtime_test process "$1"; }
build_paths()   { build_runtime_test paths "$1"; }

# ── Run tests ──────────────────────────────────────────────

# Get the XFAIL list for a suite
get_xfail_list() {
    local suite="$1"
    case "$suite" in
        include)  echo "${INCLUDE_EXPECTED_FAIL[@]:-}" ;;
        basic)    echo "${BASIC_EXPECTED_FAIL[@]:-}" ;;
        limits)   echo "${LIMITS_EXPECTED_FAIL[@]:-}" ;;
        malloc)   echo "${MALLOC_EXPECTED_FAIL[@]:-}" ;;
        stdio)    echo "${STDIO_EXPECTED_FAIL[@]:-}" ;;
        io)       echo "${IO_EXPECTED_FAIL[@]:-}" ;;
        signal)   echo "${SIGNAL_EXPECTED_FAIL[@]:-}" ;;
        process)  echo "${PROCESS_EXPECTED_FAIL[@]:-}" ;;
        paths)    echo "${PATHS_EXPECTED_FAIL[@]:-}" ;;
        *)        echo "" ;;
    esac
}

check_xfail() {
    local suite="$1"
    local test_name="$2"
    local -a xfail_list
    case "$suite" in
        include)  xfail_list=("${INCLUDE_EXPECTED_FAIL[@]:-}") ;;
        basic)    xfail_list=("${BASIC_EXPECTED_FAIL[@]:-}") ;;
        limits)   xfail_list=("${LIMITS_EXPECTED_FAIL[@]:-}") ;;
        malloc)   xfail_list=("${MALLOC_EXPECTED_FAIL[@]:-}") ;;
        stdio)    xfail_list=("${STDIO_EXPECTED_FAIL[@]:-}") ;;
        io)       xfail_list=("${IO_EXPECTED_FAIL[@]:-}") ;;
        signal)   xfail_list=("${SIGNAL_EXPECTED_FAIL[@]:-}") ;;
        process)  xfail_list=("${PROCESS_EXPECTED_FAIL[@]:-}") ;;
        paths)    xfail_list=("${PATHS_EXPECTED_FAIL[@]:-}") ;;
        *)        return 1 ;;
    esac
    [ ${#xfail_list[@]} -gt 0 ] && is_expected_fail "$test_name" "${xfail_list[@]}"
}

# Run include suite in parallel: compile all tests, then analyze results
run_include_suite() {
    local -a tests=()
    while IFS= read -r t; do
        [ -n "$t" ] && tests+=("$t")
    done < <(discover_include)

    local count=${#tests[@]}
    echo "  Discovered $count tests"
    echo "  Compiling in parallel ($(nproc 2>/dev/null || sysctl -n hw.logicalcpu) jobs)..."

    # Export variables needed by build_include_one
    export OS_TEST CC BUILD_DIR SYSROOT GLUE_DIR
    export CFLAGS_BASE_STR="${CFLAGS_BASE[*]}"
    export LINK_FLAGS_STR="${LINK_FLAGS[*]}"

    # Create a wrapper that reconstructs arrays from exported strings
    _build_include_wrapper() {
        local test_name="$1"
        local src="$OS_TEST/include/${test_name}.c"
        local wasm="$BUILD_DIR/include/${test_name}.wasm"
        local result_file="$BUILD_DIR/include/${test_name}.result"
        mkdir -p "$(dirname "$wasm")"

        # shellcheck disable=SC2086
        local -a cflags=($CFLAGS_BASE_STR -Wall -Wextra -Werror
            -Wno-error=deprecated -Wno-error=deprecated-declarations
            -I"$OS_TEST")
        # shellcheck disable=SC2086
        local -a link_flags=($LINK_FLAGS_STR)

        if "$CC" "${cflags[@]}" -D_POSIX_C_SOURCE=202405L \
            "$src" "${link_flags[@]}" -o "$wasm" 2>/dev/null; then
            echo "good" > "$result_file"; rm -f "$wasm"; return
        fi
        if "$CC" "${cflags[@]}" -D_POSIX_C_SOURCE=200809L \
            "$src" "${link_flags[@]}" -o "$wasm" 2>/dev/null; then
            echo "previous_posix" > "$result_file"; rm -f "$wasm"; return
        fi
        if "$CC" "${cflags[@]}" -D_GNU_SOURCE -D_BSD_SOURCE -D_ALL_SOURCE -D_DEFAULT_SOURCE \
            "$src" "${link_flags[@]}" -o "$wasm" 2>/dev/null; then
            echo "extension" > "$result_file"; rm -f "$wasm"; return
        fi

        local err_file="$BUILD_DIR/include/${test_name}.err"
        "$CC" "${cflags[@]}" -D_POSIX_C_SOURCE=202405L \
            "$src" "${link_flags[@]}" -o "$wasm" 2>"$err_file" || true

        if grep -q '/\*optional\*/' "$src" 2>/dev/null; then
            echo "missing_optional" > "$result_file"
        elif grep -Eq 'fatal error' "$err_file"; then
            echo "missing_header" > "$result_file"
        elif grep -Eq 'incompatible|pointer-sign' "$err_file"; then
            echo "incompatible" > "$result_file"
        elif grep -Eq 'undeclared|no member named|is not defined' "$err_file"; then
            echo "undeclared" > "$result_file"
        elif grep -Eq 'unknown type name|storage size of|expected declaration specifiers' "$err_file"; then
            echo "unknown_type" > "$result_file"
        elif grep -Eq 'undefined symbol' "$err_file"; then
            echo "undefined" > "$result_file"
        else
            echo "compile_error" > "$result_file"
        fi
        rm -f "$wasm"
    }
    export -f _build_include_wrapper

    # Run compilations in parallel
    local JOBS
    JOBS=$(nproc 2>/dev/null || sysctl -n hw.logicalcpu 2>/dev/null || echo 4)
    printf '%s\n' "${tests[@]}" | xargs -P "$JOBS" -I{} bash -c '_build_include_wrapper "$@"' _ {}

    # Analyze results
    for test_name in "${tests[@]}"; do
        TOTAL=$((TOTAL + 1))
        local result_file="$BUILD_DIR/include/${test_name}.result"
        local outcome
        outcome=$(cat "$result_file" 2>/dev/null || echo "compile_error")

        local is_xfail=false
        if check_xfail include "$test_name" 2>/dev/null; then
            is_xfail=true
        fi

        case "$outcome" in
        good|previous_posix|extension)
            if $is_xfail; then
                echo "XPASS include/${test_name} ($outcome)"
                RESULTS+=("XPASS include/${test_name}")
                XPASS=$((XPASS + 1))
            else
                RESULTS+=("PASS  include/${test_name}")
                PASS=$((PASS + 1))
            fi
            ;;
        *)
            if $is_xfail; then
                RESULTS+=("XFAIL include/${test_name}")
                XFAIL=$((XFAIL + 1))
            elif [ "$outcome" = "missing_optional" ]; then
                RESULTS+=("SKIP  include/${test_name}")
                SKIP=$((SKIP + 1))
            else
                echo "FAIL  include/${test_name} ($outcome)"
                RESULTS+=("FAIL  include/${test_name}")
                FAIL=$((FAIL + 1))
            fi
            ;;
        esac
    done
}

# Run a runtime test (compile + execute)
run_runtime_test() {
    local suite="$1"
    local test_name="$2"
    local wasm="$BUILD_DIR/$suite/${test_name}.wasm"

    local is_xfail=false
    if check_xfail "$suite" "$test_name" 2>/dev/null; then
        is_xfail=true
    fi

    # Build
    if ! "build_${suite}" "$test_name" 2>/dev/null; then
        local err
        err=$(head -5 /tmp/sortix-build-err.txt 2>/dev/null || echo "(no error output)")
        if $is_xfail; then
            RESULTS+=("XFAIL ${suite}/${test_name}")
            XFAIL=$((XFAIL + 1))
        else
            echo "BUILD ${suite}/${test_name}"
            echo "$err" | head -3 | sed 's/^/  /'
            RESULTS+=("BUILD ${suite}/${test_name}")
            BUILD_FAIL=$((BUILD_FAIL + 1))
        fi
        return
    fi

    # Run with timeout
    set +e
    output=$(cd "$REPO_ROOT" && timeout "$TEST_TIMEOUT" npx tsx examples/run-example.ts "${wasm}" 2>&1)
    rc=$?
    set -e

    # Sortix convention: if output is empty or exit code >= 2,
    # append "exit: N" to the output (matches os-test/misc/run.sh)
    if [ -z "$output" ] || [ "$rc" -ge 2 ]; then
        if [ -n "$output" ]; then
            output="$output
exit: $rc"
        else
            output="exit: $rc"
        fi
    fi

    # For suites with .expect files, compare output
    local has_expect=false
    local expect_dir="$OS_TEST/${suite}.expect"
    if [ -d "$expect_dir" ]; then
        has_expect=true
    fi

    local test_passed=false
    if [ $rc -eq 124 ]; then
        # Timeout
        if $is_xfail; then
            RESULTS+=("XFAIL ${suite}/${test_name}")
            XFAIL=$((XFAIL + 1))
        else
            echo "TIME  ${suite}/${test_name} (timeout ${TEST_TIMEOUT}s)"
            RESULTS+=("TIME  ${suite}/${test_name}")
            TIMEOUT_COUNT=$((TIMEOUT_COUNT + 1))
        fi
        return
    fi

    # Check output against expect files (if available).
    # Tests may have multiple valid outputs: .posix (always valid),
    # .posix.N variants, or .N numbered variants (e.g. .1 = path exists,
    # .2 = path doesn't exist). Any variant match = pass.
    if $has_expect; then
        local expect_base="${test_name##*/}"
        for expect_file in "$expect_dir/${expect_base}.posix" "$expect_dir/${expect_base}.posix."* "$expect_dir/${expect_base}."[0-9]*; do
            [ -f "$expect_file" ] || continue
            local expected
            expected=$(cat "$expect_file")
            if [ "$output" = "$expected" ]; then
                test_passed=true
                break
            fi
        done
    elif [ $rc -eq 0 ]; then
        # No expect files — exit 0 means pass
        test_passed=true
    fi

    if $test_passed; then
        if $is_xfail; then
            echo "XPASS ${suite}/${test_name}"
            RESULTS+=("XPASS ${suite}/${test_name}")
            XPASS=$((XPASS + 1))
        else
            echo "PASS  ${suite}/${test_name}"
            RESULTS+=("PASS  ${suite}/${test_name}")
            PASS=$((PASS + 1))
        fi
    else
        if $is_xfail; then
            RESULTS+=("XFAIL ${suite}/${test_name}")
            XFAIL=$((XFAIL + 1))
        else
            echo "FAIL  ${suite}/${test_name} (exit $rc)"
            echo "$output" | tail -5 | head -3 | sed 's/^/  /'
            RESULTS+=("FAIL  ${suite}/${test_name}")
            FAIL=$((FAIL + 1))
        fi
    fi
}

# ── Run a suite ────────────────────────────────────────────

run_suite() {
    local suite="$1"
    shift
    local -a specific_tests=("$@")

    echo ""
    echo "===== ${suite} tests ====="
    echo ""

    if [ "$suite" = "include" ]; then
        # Include suite uses parallel compilation
        run_include_suite
        # Print suite summary
        local suite_pass=0 suite_fail=0 suite_xfail=0 suite_skip=0
        for r in "${RESULTS[@]}"; do
            case "$r" in
                "PASS  include/"*)  suite_pass=$((suite_pass + 1)) ;;
                "FAIL  include/"*)  suite_fail=$((suite_fail + 1)) ;;
                "XFAIL include/"*)  suite_xfail=$((suite_xfail + 1)) ;;
                "SKIP  include/"*)  suite_skip=$((suite_skip + 1)) ;;
                "XPASS include/"*)  suite_pass=$((suite_pass + 1)) ;;
            esac
        done
        echo "  include: $suite_pass pass, $suite_fail fail, $suite_xfail xfail, $suite_skip skip"
        return
    fi

    local tests=()
    if [ ${#specific_tests[@]} -gt 0 ]; then
        tests=("${specific_tests[@]}")
    else
        while IFS= read -r t; do
            [ -n "$t" ] && tests+=("$t")
        done < <("discover_${suite}")
    fi

    local count=${#tests[@]}
    echo "  Discovered $count tests"

    for test_name in "${tests[@]}"; do
        TOTAL=$((TOTAL + 1))
        run_runtime_test "$suite" "$test_name"
    done
}

# ── Main ────────────────────────────────────────────────────

REPORT_MODE=false
ALL_MODE=false
SUITES=()
SPECIFIC_TESTS=()

DEFAULT_SUITES=(include limits basic malloc stdio)
ALL_SUITES=(include limits basic malloc stdio io signal process paths)

while [ $# -gt 0 ]; do
    case "$1" in
        --report) REPORT_MODE=true; ALL_MODE=true; shift ;;
        --all)    ALL_MODE=true; shift ;;
        include|limits|basic|malloc|stdio|io|signal|process|paths)
            SUITES+=("$1"); shift
            # Collect specific tests for this suite
            while [ $# -gt 0 ] && [[ "$1" != --* ]] && ! [[ "$1" =~ ^(include|limits|basic|malloc|stdio|io|signal|process|paths)$ ]]; do
                SPECIFIC_TESTS+=("$1"); shift
            done
            ;;
        *) echo "Unknown argument: $1"; exit 1 ;;
    esac
done

if [ ${#SUITES[@]} -eq 0 ]; then
    if $ALL_MODE; then
        SUITES=("${ALL_SUITES[@]}")
    else
        SUITES=("${DEFAULT_SUITES[@]}")
    fi
fi

# Verify prerequisites
if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "Error: sysroot not found. Run scripts/build-musl.sh first." >&2
    exit 1
fi
if [ ! -f "$KERNEL_WASM" ]; then
    echo "Error: kernel wasm not found. Run build.sh first." >&2
    exit 1
fi
if [ ! -d "$OS_TEST" ]; then
    echo "Error: os-test not found. Run: git submodule update --init os-test" >&2
    exit 1
fi

PASS=0
FAIL=0
SKIP=0
BUILD_FAIL=0
TIMEOUT_COUNT=0
XFAIL=0
XPASS=0
RESULTS=()
TOTAL=0

for suite in "${SUITES[@]}"; do
    run_suite "$suite" "${SPECIFIC_TESTS[@]+${SPECIFIC_TESTS[@]}}"
    SPECIFIC_TESTS=()  # Only apply to first suite
done

# ── Summary ─────────────────────────────────────────────────

echo ""
echo "===== Results ====="
echo "PASS:    $PASS"
echo "FAIL:    $FAIL"
echo "XFAIL:   $XFAIL"
echo "XPASS:   $XPASS"
echo "BUILD:   $BUILD_FAIL"
echo "SKIP:    $SKIP"
echo "TIMEOUT: $TIMEOUT_COUNT"
echo "TOTAL:   $TOTAL"
echo ""

# Group non-PASS results
for status in FAIL XPASS BUILD TIME; do
    count=0
    for r in "${RESULTS[@]}"; do
        [[ "$r" == "$status "* ]] && count=$((count + 1))
    done
    if [ $count -gt 0 ]; then
        echo "── ${status} ($count) ──"
        for r in "${RESULTS[@]}"; do
            [[ "$r" == "$status "* ]] && echo "  $r"
        done
        echo ""
    fi
done

# ── Report mode ─────────────────────────────────────────────

if $REPORT_MODE; then
    REPORT="$REPO_ROOT/docs/sortix-test-report.md"
    {
        echo "# Sortix os-test Conformance Report"
        echo ""
        echo "Generated: $(date -u '+%Y-%m-%d %H:%M UTC')"
        echo ""
        echo "| Status | Count |"
        echo "|--------|-------|"
        echo "| PASS | $PASS |"
        echo "| FAIL | $FAIL |"
        echo "| XFAIL | $XFAIL |"
        echo "| XPASS | $XPASS |"
        echo "| BUILD | $BUILD_FAIL |"
        echo "| SKIP | $SKIP |"
        echo "| TIMEOUT | $TIMEOUT_COUNT |"
        echo "| **TOTAL** | **$TOTAL** |"
        echo ""

        for status in FAIL BUILD TIME; do
            count=0
            for r in "${RESULTS[@]}"; do
                [[ "$r" == "$status "* ]] && count=$((count + 1))
            done
            if [ $count -gt 0 ]; then
                case "$status" in
                    FAIL) echo "## Unexpected Failures ($count)" ;;
                    BUILD) echo "## Build Failures ($count)" ;;
                    TIME) echo "## Timeouts ($count)" ;;
                esac
                echo ""
                echo "| Test | Suite |"
                echo "|------|-------|"
                for r in "${RESULTS[@]}"; do
                    if [[ "$r" == "$status "* ]]; then
                        local_test="${r#* }"
                        local_suite="${local_test%%/*}"
                        local_name="${local_test#*/}"
                        echo "| \`$local_name\` | $local_suite |"
                    fi
                done
                echo ""
            fi
        done
    } > "$REPORT"
    echo "Report written to: $REPORT"
fi

# Exit with error if any unexpected failures
if [ $FAIL -gt 0 ] || [ $XPASS -gt 0 ] || [ $BUILD_FAIL -gt 0 ]; then
    exit 1
fi
