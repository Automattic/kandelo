#define _GNU_SOURCE

#include <bits/kandelo_process_layouts.h>
#include <sched.h>
#include <signal.h>
#include <stddef.h>
#include <sys/stat.h>

#define ASSERT_OFFSET(type, field, expected) \
	_Static_assert(offsetof(type, field) == (expected), #type "." #field)

_Static_assert(sizeof(struct stat) == 112, "struct stat size");
ASSERT_OFFSET(struct stat, st_dev, 0);
ASSERT_OFFSET(struct stat, st_ino, 8);
ASSERT_OFFSET(struct stat, st_mode, 16);
ASSERT_OFFSET(struct stat, st_nlink, 20);
ASSERT_OFFSET(struct stat, st_uid, 24);
ASSERT_OFFSET(struct stat, st_gid, 28);
ASSERT_OFFSET(struct stat, st_size, 32);
ASSERT_OFFSET(struct stat, st_atim, 40);
ASSERT_OFFSET(struct stat, st_mtim, 56);
ASSERT_OFFSET(struct stat, st_ctim, 72);
ASSERT_OFFSET(struct stat, st_rdev, 88);
ASSERT_OFFSET(struct stat, st_blksize, 96);
ASSERT_OFFSET(struct stat, st_blocks, 104);

_Static_assert(sizeof(struct sched_param) == 48, "sched_param size");
ASSERT_OFFSET(struct sched_param, sched_priority, 0);
ASSERT_OFFSET(struct sched_param, sched_ss_max_repl, 4);
ASSERT_OFFSET(struct sched_param, sched_ss_repl_period, 8);
ASSERT_OFFSET(struct sched_param, sched_ss_init_budget, 24);
ASSERT_OFFSET(struct sched_param, sched_ss_low_priority, 40);

#if __SIZEOF_POINTER__ == 4

#include "../../libc/musl-overlay/arch/wasm32posix/kstat.h"

_Static_assert(sizeof(siginfo_t) == KANDELO_PROCESS_SIGINFO_WASM32_SIZE,
	       "generated wasm32 siginfo_t size");
_Static_assert(sizeof(union sigval) ==
	       KANDELO_PROCESS_SIGINFO_WASM32_VALUE_SIZE,
	       "generated wasm32 siginfo sigval width");
ASSERT_OFFSET(siginfo_t, si_pid, KANDELO_PROCESS_SIGINFO_WASM32_PID_OFFSET);
ASSERT_OFFSET(siginfo_t, si_uid, KANDELO_PROCESS_SIGINFO_WASM32_UID_OFFSET);
ASSERT_OFFSET(siginfo_t, si_value,
	      KANDELO_PROCESS_SIGINFO_WASM32_VALUE_OFFSET);

#elif __SIZEOF_POINTER__ == 8

#include "../../libc/musl-overlay/arch/wasm64posix/kstat.h"

_Static_assert(sizeof(siginfo_t) == KANDELO_PROCESS_SIGINFO_WASM64_SIZE,
	       "generated wasm64 siginfo_t size");
_Static_assert(sizeof(union sigval) ==
	       KANDELO_PROCESS_SIGINFO_WASM64_VALUE_SIZE,
	       "generated wasm64 siginfo sigval width");
ASSERT_OFFSET(siginfo_t, si_pid, KANDELO_PROCESS_SIGINFO_WASM64_PID_OFFSET);
ASSERT_OFFSET(siginfo_t, si_uid, KANDELO_PROCESS_SIGINFO_WASM64_UID_OFFSET);
ASSERT_OFFSET(siginfo_t, si_value,
	      KANDELO_PROCESS_SIGINFO_WASM64_VALUE_OFFSET);

#else
#error "Kandelo supports only four- and eight-byte process pointers"
#endif

_Static_assert(sizeof(struct kstat) == 112, "native kstat size");
ASSERT_OFFSET(struct kstat, st_rdev, 88);
ASSERT_OFFSET(struct kstat, st_blksize, 96);
ASSERT_OFFSET(struct kstat, st_blocks, 104);
