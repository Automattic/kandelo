#define _GNU_SOURCE

#include <sched.h>
#include <signal.h>
#include <stddef.h>
#include <sys/stat.h>

#define ASSERT_OFFSET(type, field, expected) \
	_Static_assert(offsetof(type, field) == (expected), #type "." #field)

_Static_assert(sizeof(siginfo_t) == 128, "siginfo_t size");
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

ASSERT_OFFSET(siginfo_t, si_pid, 12);
ASSERT_OFFSET(siginfo_t, si_uid, 16);
ASSERT_OFFSET(siginfo_t, si_value, 20);

#elif __SIZEOF_POINTER__ == 8

#include "../../libc/musl-overlay/arch/wasm64posix/kstat.h"

ASSERT_OFFSET(siginfo_t, si_pid, 16);
ASSERT_OFFSET(siginfo_t, si_uid, 20);
ASSERT_OFFSET(siginfo_t, si_value, 24);

#else
#error "Kandelo supports only four- and eight-byte process pointers"
#endif

_Static_assert(sizeof(struct kstat) == 112, "native kstat size");
ASSERT_OFFSET(struct kstat, st_rdev, 88);
ASSERT_OFFSET(struct kstat, st_blksize, 96);
ASSERT_OFFSET(struct kstat, st_blocks, 104);
