/* GENERATED-ADJACENT, HAND-WRITTEN. Lane G (ABI binding drift).
 *
 * Every assert here compares musl's OWN struct against a macro generated from
 * crates/shared/src/process_layout.rs by `cargo xtask dump-abi`. Asserting
 * against a literal instead would let the two drift apart while both sides
 * look checked -- which is how `statx` came to write `stx_dev_major` from the
 * low 32 bits and never write `stx_dev_minor` at all, with nothing objecting.
 *
 * This file exists so the asserts land in libc.a and `scripts/build-musl.sh`
 * verifies them. musl's Makefile globs src/<dir>/*.c, so no build edit is
 * needed. It defines no symbols on purpose.
 *
 * After editing, run `scripts/build-musl.sh` -- the compile reads the SYSROOT
 * copy of the generated header, not libc/musl-overlay/.
 */
#define _GNU_SOURCE
#include <stddef.h>
#include <signal.h>
#include <sched.h>
#include <mqueue.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/sysinfo.h>
#include <bits/kandelo_process_layouts.h>

/* --- statfs: width-selected, matching the rest of the libc glue --- */
#if __SIZEOF_POINTER__ == 8
#define KANDELO_NATIVE_STATFS_SIZE KANDELO_PROCESS_STATFS_WASM64_SIZE
#define KANDELO_NATIVE_STATFS_TYPE_OFFSET KANDELO_PROCESS_STATFS_WASM64_TYPE_OFFSET
#define KANDELO_NATIVE_STATFS_BSIZE_OFFSET KANDELO_PROCESS_STATFS_WASM64_BSIZE_OFFSET
#define KANDELO_NATIVE_STATFS_BLOCKS_OFFSET KANDELO_PROCESS_STATFS_WASM64_BLOCKS_OFFSET
#define KANDELO_NATIVE_STATFS_BFREE_OFFSET KANDELO_PROCESS_STATFS_WASM64_BFREE_OFFSET
#define KANDELO_NATIVE_STATFS_BAVAIL_OFFSET KANDELO_PROCESS_STATFS_WASM64_BAVAIL_OFFSET
#define KANDELO_NATIVE_STATFS_FILES_OFFSET KANDELO_PROCESS_STATFS_WASM64_FILES_OFFSET
#define KANDELO_NATIVE_STATFS_FFREE_OFFSET KANDELO_PROCESS_STATFS_WASM64_FFREE_OFFSET
#define KANDELO_NATIVE_STATFS_FSID_OFFSET KANDELO_PROCESS_STATFS_WASM64_FSID_OFFSET
#define KANDELO_NATIVE_STATFS_NAMELEN_OFFSET KANDELO_PROCESS_STATFS_WASM64_NAMELEN_OFFSET
#define KANDELO_NATIVE_STATFS_FRSIZE_OFFSET KANDELO_PROCESS_STATFS_WASM64_FRSIZE_OFFSET
#define KANDELO_NATIVE_STATFS_FLAGS_OFFSET KANDELO_PROCESS_STATFS_WASM64_FLAGS_OFFSET
#define KANDELO_NATIVE_STATFS_SPARE_OFFSET KANDELO_PROCESS_STATFS_WASM64_SPARE_OFFSET
#else
#define KANDELO_NATIVE_STATFS_SIZE KANDELO_PROCESS_STATFS_WASM32_SIZE
#define KANDELO_NATIVE_STATFS_TYPE_OFFSET KANDELO_PROCESS_STATFS_WASM32_TYPE_OFFSET
#define KANDELO_NATIVE_STATFS_BSIZE_OFFSET KANDELO_PROCESS_STATFS_WASM32_BSIZE_OFFSET
#define KANDELO_NATIVE_STATFS_BLOCKS_OFFSET KANDELO_PROCESS_STATFS_WASM32_BLOCKS_OFFSET
#define KANDELO_NATIVE_STATFS_BFREE_OFFSET KANDELO_PROCESS_STATFS_WASM32_BFREE_OFFSET
#define KANDELO_NATIVE_STATFS_BAVAIL_OFFSET KANDELO_PROCESS_STATFS_WASM32_BAVAIL_OFFSET
#define KANDELO_NATIVE_STATFS_FILES_OFFSET KANDELO_PROCESS_STATFS_WASM32_FILES_OFFSET
#define KANDELO_NATIVE_STATFS_FFREE_OFFSET KANDELO_PROCESS_STATFS_WASM32_FFREE_OFFSET
#define KANDELO_NATIVE_STATFS_FSID_OFFSET KANDELO_PROCESS_STATFS_WASM32_FSID_OFFSET
#define KANDELO_NATIVE_STATFS_NAMELEN_OFFSET KANDELO_PROCESS_STATFS_WASM32_NAMELEN_OFFSET
#define KANDELO_NATIVE_STATFS_FRSIZE_OFFSET KANDELO_PROCESS_STATFS_WASM32_FRSIZE_OFFSET
#define KANDELO_NATIVE_STATFS_FLAGS_OFFSET KANDELO_PROCESS_STATFS_WASM32_FLAGS_OFFSET
#define KANDELO_NATIVE_STATFS_SPARE_OFFSET KANDELO_PROCESS_STATFS_WASM32_SPARE_OFFSET
#endif
_Static_assert(sizeof(struct statfs) == KANDELO_NATIVE_STATFS_SIZE,
	"statfs SIZE drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statfs, f_type) == KANDELO_NATIVE_STATFS_TYPE_OFFSET,
	"statfs TYPE_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statfs, f_bsize) == KANDELO_NATIVE_STATFS_BSIZE_OFFSET,
	"statfs BSIZE_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statfs, f_blocks) == KANDELO_NATIVE_STATFS_BLOCKS_OFFSET,
	"statfs BLOCKS_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statfs, f_bfree) == KANDELO_NATIVE_STATFS_BFREE_OFFSET,
	"statfs BFREE_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statfs, f_bavail) == KANDELO_NATIVE_STATFS_BAVAIL_OFFSET,
	"statfs BAVAIL_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statfs, f_files) == KANDELO_NATIVE_STATFS_FILES_OFFSET,
	"statfs FILES_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statfs, f_ffree) == KANDELO_NATIVE_STATFS_FFREE_OFFSET,
	"statfs FFREE_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statfs, f_fsid) == KANDELO_NATIVE_STATFS_FSID_OFFSET,
	"statfs FSID_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statfs, f_namelen) == KANDELO_NATIVE_STATFS_NAMELEN_OFFSET,
	"statfs NAMELEN_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statfs, f_frsize) == KANDELO_NATIVE_STATFS_FRSIZE_OFFSET,
	"statfs FRSIZE_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statfs, f_flags) == KANDELO_NATIVE_STATFS_FLAGS_OFFSET,
	"statfs FLAGS_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statfs, f_spare) == KANDELO_NATIVE_STATFS_SPARE_OFFSET,
	"statfs SPARE_OFFSET drifted from crates/shared/src/process_layout.rs");

/* --- sysinfo: width-selected, matching the rest of the libc glue --- */
#if __SIZEOF_POINTER__ == 8
#define KANDELO_NATIVE_SYSINFO_SIZE KANDELO_PROCESS_SYSINFO_WASM64_SIZE
#define KANDELO_NATIVE_SYSINFO_UPTIME_OFFSET KANDELO_PROCESS_SYSINFO_WASM64_UPTIME_OFFSET
#define KANDELO_NATIVE_SYSINFO_LOADS_OFFSET KANDELO_PROCESS_SYSINFO_WASM64_LOADS_OFFSET
#define KANDELO_NATIVE_SYSINFO_TOTALRAM_OFFSET KANDELO_PROCESS_SYSINFO_WASM64_TOTALRAM_OFFSET
#define KANDELO_NATIVE_SYSINFO_FREERAM_OFFSET KANDELO_PROCESS_SYSINFO_WASM64_FREERAM_OFFSET
#define KANDELO_NATIVE_SYSINFO_SHAREDRAM_OFFSET KANDELO_PROCESS_SYSINFO_WASM64_SHAREDRAM_OFFSET
#define KANDELO_NATIVE_SYSINFO_BUFFERRAM_OFFSET KANDELO_PROCESS_SYSINFO_WASM64_BUFFERRAM_OFFSET
#define KANDELO_NATIVE_SYSINFO_TOTALSWAP_OFFSET KANDELO_PROCESS_SYSINFO_WASM64_TOTALSWAP_OFFSET
#define KANDELO_NATIVE_SYSINFO_FREESWAP_OFFSET KANDELO_PROCESS_SYSINFO_WASM64_FREESWAP_OFFSET
#define KANDELO_NATIVE_SYSINFO_PROCS_OFFSET KANDELO_PROCESS_SYSINFO_WASM64_PROCS_OFFSET
#define KANDELO_NATIVE_SYSINFO_TOTALHIGH_OFFSET KANDELO_PROCESS_SYSINFO_WASM64_TOTALHIGH_OFFSET
#define KANDELO_NATIVE_SYSINFO_FREEHIGH_OFFSET KANDELO_PROCESS_SYSINFO_WASM64_FREEHIGH_OFFSET
#define KANDELO_NATIVE_SYSINFO_MEM_UNIT_OFFSET KANDELO_PROCESS_SYSINFO_WASM64_MEM_UNIT_OFFSET
#define KANDELO_NATIVE_SYSINFO_RESERVED_OFFSET KANDELO_PROCESS_SYSINFO_WASM64_RESERVED_OFFSET
#else
#define KANDELO_NATIVE_SYSINFO_SIZE KANDELO_PROCESS_SYSINFO_WASM32_SIZE
#define KANDELO_NATIVE_SYSINFO_UPTIME_OFFSET KANDELO_PROCESS_SYSINFO_WASM32_UPTIME_OFFSET
#define KANDELO_NATIVE_SYSINFO_LOADS_OFFSET KANDELO_PROCESS_SYSINFO_WASM32_LOADS_OFFSET
#define KANDELO_NATIVE_SYSINFO_TOTALRAM_OFFSET KANDELO_PROCESS_SYSINFO_WASM32_TOTALRAM_OFFSET
#define KANDELO_NATIVE_SYSINFO_FREERAM_OFFSET KANDELO_PROCESS_SYSINFO_WASM32_FREERAM_OFFSET
#define KANDELO_NATIVE_SYSINFO_SHAREDRAM_OFFSET KANDELO_PROCESS_SYSINFO_WASM32_SHAREDRAM_OFFSET
#define KANDELO_NATIVE_SYSINFO_BUFFERRAM_OFFSET KANDELO_PROCESS_SYSINFO_WASM32_BUFFERRAM_OFFSET
#define KANDELO_NATIVE_SYSINFO_TOTALSWAP_OFFSET KANDELO_PROCESS_SYSINFO_WASM32_TOTALSWAP_OFFSET
#define KANDELO_NATIVE_SYSINFO_FREESWAP_OFFSET KANDELO_PROCESS_SYSINFO_WASM32_FREESWAP_OFFSET
#define KANDELO_NATIVE_SYSINFO_PROCS_OFFSET KANDELO_PROCESS_SYSINFO_WASM32_PROCS_OFFSET
#define KANDELO_NATIVE_SYSINFO_TOTALHIGH_OFFSET KANDELO_PROCESS_SYSINFO_WASM32_TOTALHIGH_OFFSET
#define KANDELO_NATIVE_SYSINFO_FREEHIGH_OFFSET KANDELO_PROCESS_SYSINFO_WASM32_FREEHIGH_OFFSET
#define KANDELO_NATIVE_SYSINFO_MEM_UNIT_OFFSET KANDELO_PROCESS_SYSINFO_WASM32_MEM_UNIT_OFFSET
#define KANDELO_NATIVE_SYSINFO_RESERVED_OFFSET KANDELO_PROCESS_SYSINFO_WASM32_RESERVED_OFFSET
#endif
_Static_assert(sizeof(struct sysinfo) == KANDELO_NATIVE_SYSINFO_SIZE,
	"sysinfo SIZE drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct sysinfo, uptime) == KANDELO_NATIVE_SYSINFO_UPTIME_OFFSET,
	"sysinfo UPTIME_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct sysinfo, loads) == KANDELO_NATIVE_SYSINFO_LOADS_OFFSET,
	"sysinfo LOADS_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct sysinfo, totalram) == KANDELO_NATIVE_SYSINFO_TOTALRAM_OFFSET,
	"sysinfo TOTALRAM_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct sysinfo, freeram) == KANDELO_NATIVE_SYSINFO_FREERAM_OFFSET,
	"sysinfo FREERAM_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct sysinfo, sharedram) == KANDELO_NATIVE_SYSINFO_SHAREDRAM_OFFSET,
	"sysinfo SHAREDRAM_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct sysinfo, bufferram) == KANDELO_NATIVE_SYSINFO_BUFFERRAM_OFFSET,
	"sysinfo BUFFERRAM_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct sysinfo, totalswap) == KANDELO_NATIVE_SYSINFO_TOTALSWAP_OFFSET,
	"sysinfo TOTALSWAP_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct sysinfo, freeswap) == KANDELO_NATIVE_SYSINFO_FREESWAP_OFFSET,
	"sysinfo FREESWAP_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct sysinfo, procs) == KANDELO_NATIVE_SYSINFO_PROCS_OFFSET,
	"sysinfo PROCS_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct sysinfo, totalhigh) == KANDELO_NATIVE_SYSINFO_TOTALHIGH_OFFSET,
	"sysinfo TOTALHIGH_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct sysinfo, freehigh) == KANDELO_NATIVE_SYSINFO_FREEHIGH_OFFSET,
	"sysinfo FREEHIGH_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct sysinfo, mem_unit) == KANDELO_NATIVE_SYSINFO_MEM_UNIT_OFFSET,
	"sysinfo MEM_UNIT_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct sysinfo, __reserved) == KANDELO_NATIVE_SYSINFO_RESERVED_OFFSET,
	"sysinfo RESERVED_OFFSET drifted from crates/shared/src/process_layout.rs");

/* --- mq_attr: width-selected, matching the rest of the libc glue --- */
#if __SIZEOF_POINTER__ == 8
#define KANDELO_NATIVE_MQ_ATTR_SIZE KANDELO_PROCESS_MQ_ATTR_WASM64_SIZE
#define KANDELO_NATIVE_MQ_ATTR_FLAGS_OFFSET KANDELO_PROCESS_MQ_ATTR_WASM64_FLAGS_OFFSET
#define KANDELO_NATIVE_MQ_ATTR_MAXMSG_OFFSET KANDELO_PROCESS_MQ_ATTR_WASM64_MAXMSG_OFFSET
#define KANDELO_NATIVE_MQ_ATTR_MSGSIZE_OFFSET KANDELO_PROCESS_MQ_ATTR_WASM64_MSGSIZE_OFFSET
#define KANDELO_NATIVE_MQ_ATTR_CURMSGS_OFFSET KANDELO_PROCESS_MQ_ATTR_WASM64_CURMSGS_OFFSET
#else
#define KANDELO_NATIVE_MQ_ATTR_SIZE KANDELO_PROCESS_MQ_ATTR_WASM32_SIZE
#define KANDELO_NATIVE_MQ_ATTR_FLAGS_OFFSET KANDELO_PROCESS_MQ_ATTR_WASM32_FLAGS_OFFSET
#define KANDELO_NATIVE_MQ_ATTR_MAXMSG_OFFSET KANDELO_PROCESS_MQ_ATTR_WASM32_MAXMSG_OFFSET
#define KANDELO_NATIVE_MQ_ATTR_MSGSIZE_OFFSET KANDELO_PROCESS_MQ_ATTR_WASM32_MSGSIZE_OFFSET
#define KANDELO_NATIVE_MQ_ATTR_CURMSGS_OFFSET KANDELO_PROCESS_MQ_ATTR_WASM32_CURMSGS_OFFSET
#endif
_Static_assert(sizeof(struct mq_attr) == KANDELO_NATIVE_MQ_ATTR_SIZE,
	"mq_attr SIZE drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct mq_attr, mq_flags) == KANDELO_NATIVE_MQ_ATTR_FLAGS_OFFSET,
	"mq_attr FLAGS_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct mq_attr, mq_maxmsg) == KANDELO_NATIVE_MQ_ATTR_MAXMSG_OFFSET,
	"mq_attr MAXMSG_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct mq_attr, mq_msgsize) == KANDELO_NATIVE_MQ_ATTR_MSGSIZE_OFFSET,
	"mq_attr MSGSIZE_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct mq_attr, mq_curmsgs) == KANDELO_NATIVE_MQ_ATTR_CURMSGS_OFFSET,
	"mq_attr CURMSGS_OFFSET drifted from crates/shared/src/process_layout.rs");

/* --- sigaltstack: width-selected, matching the rest of the libc glue --- */
#if __SIZEOF_POINTER__ == 8
#define KANDELO_NATIVE_SIGALTSTACK_SIZE KANDELO_PROCESS_SIGALTSTACK_WASM64_SIZE
#define KANDELO_NATIVE_SIGALTSTACK_SP_OFFSET KANDELO_PROCESS_SIGALTSTACK_WASM64_SP_OFFSET
#define KANDELO_NATIVE_SIGALTSTACK_FLAGS_OFFSET KANDELO_PROCESS_SIGALTSTACK_WASM64_FLAGS_OFFSET
#define KANDELO_NATIVE_SIGALTSTACK_STACK_SIZE_OFFSET KANDELO_PROCESS_SIGALTSTACK_WASM64_STACK_SIZE_OFFSET
#else
#define KANDELO_NATIVE_SIGALTSTACK_SIZE KANDELO_PROCESS_SIGALTSTACK_WASM32_SIZE
#define KANDELO_NATIVE_SIGALTSTACK_SP_OFFSET KANDELO_PROCESS_SIGALTSTACK_WASM32_SP_OFFSET
#define KANDELO_NATIVE_SIGALTSTACK_FLAGS_OFFSET KANDELO_PROCESS_SIGALTSTACK_WASM32_FLAGS_OFFSET
#define KANDELO_NATIVE_SIGALTSTACK_STACK_SIZE_OFFSET KANDELO_PROCESS_SIGALTSTACK_WASM32_STACK_SIZE_OFFSET
#endif
_Static_assert(sizeof(stack_t) == KANDELO_NATIVE_SIGALTSTACK_SIZE,
	"sigaltstack SIZE drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(stack_t, ss_sp) == KANDELO_NATIVE_SIGALTSTACK_SP_OFFSET,
	"sigaltstack SP_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(stack_t, ss_flags) == KANDELO_NATIVE_SIGALTSTACK_FLAGS_OFFSET,
	"sigaltstack FLAGS_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(stack_t, ss_size) == KANDELO_NATIVE_SIGALTSTACK_STACK_SIZE_OFFSET,
	"sigaltstack STACK_SIZE_OFFSET drifted from crates/shared/src/process_layout.rs");

/* --- statx: width-independent --- */
_Static_assert(sizeof(struct statx) == KANDELO_PROCESS_STATX_SIZE,
	"statx SIZE drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statx, stx_mask) == KANDELO_PROCESS_STATX_MASK_OFFSET,
	"statx MASK_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statx, stx_blksize) == KANDELO_PROCESS_STATX_BLKSIZE_OFFSET,
	"statx BLKSIZE_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statx, stx_attributes) == KANDELO_PROCESS_STATX_ATTRIBUTES_OFFSET,
	"statx ATTRIBUTES_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statx, stx_nlink) == KANDELO_PROCESS_STATX_NLINK_OFFSET,
	"statx NLINK_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statx, stx_uid) == KANDELO_PROCESS_STATX_UID_OFFSET,
	"statx UID_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statx, stx_gid) == KANDELO_PROCESS_STATX_GID_OFFSET,
	"statx GID_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statx, stx_mode) == KANDELO_PROCESS_STATX_MODE_OFFSET,
	"statx MODE_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statx, stx_ino) == KANDELO_PROCESS_STATX_INO_OFFSET,
	"statx INO_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statx, stx_size) == KANDELO_PROCESS_STATX_SIZE_FIELD_OFFSET,
	"statx SIZE_FIELD_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statx, stx_blocks) == KANDELO_PROCESS_STATX_BLOCKS_OFFSET,
	"statx BLOCKS_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statx, stx_attributes_mask) == KANDELO_PROCESS_STATX_ATTRIBUTES_MASK_OFFSET,
	"statx ATTRIBUTES_MASK_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statx, stx_atime) == KANDELO_PROCESS_STATX_ATIME_SEC_OFFSET,
	"statx ATIME_SEC_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statx, stx_atime.tv_nsec) == KANDELO_PROCESS_STATX_ATIME_NSEC_OFFSET,
	"statx ATIME_NSEC_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statx, stx_btime) == KANDELO_PROCESS_STATX_BTIME_SEC_OFFSET,
	"statx BTIME_SEC_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statx, stx_ctime) == KANDELO_PROCESS_STATX_CTIME_SEC_OFFSET,
	"statx CTIME_SEC_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statx, stx_ctime.tv_nsec) == KANDELO_PROCESS_STATX_CTIME_NSEC_OFFSET,
	"statx CTIME_NSEC_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statx, stx_mtime) == KANDELO_PROCESS_STATX_MTIME_SEC_OFFSET,
	"statx MTIME_SEC_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statx, stx_mtime.tv_nsec) == KANDELO_PROCESS_STATX_MTIME_NSEC_OFFSET,
	"statx MTIME_NSEC_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statx, stx_rdev_major) == KANDELO_PROCESS_STATX_RDEV_MAJOR_OFFSET,
	"statx RDEV_MAJOR_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statx, stx_rdev_minor) == KANDELO_PROCESS_STATX_RDEV_MINOR_OFFSET,
	"statx RDEV_MINOR_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statx, stx_dev_major) == KANDELO_PROCESS_STATX_DEV_MAJOR_OFFSET,
	"statx DEV_MAJOR_OFFSET drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct statx, stx_dev_minor) == KANDELO_PROCESS_STATX_DEV_MINOR_OFFSET,
	"statx DEV_MINOR_OFFSET drifted from crates/shared/src/process_layout.rs");

/* --- sched_param: width-independent --- */
_Static_assert(sizeof(struct sched_param) == KANDELO_PROCESS_SCHED_PARAM_SIZE,
	"sched_param SIZE drifted from crates/shared/src/process_layout.rs");
_Static_assert(offsetof(struct sched_param, sched_priority) == KANDELO_PROCESS_SCHED_PARAM_PRIORITY_OFFSET,
	"sched_param PRIORITY_OFFSET drifted from crates/shared/src/process_layout.rs");

/* sched_param's sporadic-server fields (SS_MAX_REPL, SS_REPL_PERIOD_*,
 * SS_INIT_BUDGET_*, SS_LOW_PRIORITY) live inside musl's `__reserved2` and have
 * no portable member name, so only the size and `sched_priority` are asserted
 * here. The remaining six offsets are unguarded and lane G should say so
 * rather than imply the module is fully covered.
 */
