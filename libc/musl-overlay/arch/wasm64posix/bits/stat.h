/* bits/stat.h — wasm64posix struct stat
 *
 * The kernel writes a complete 112-byte native kstat and musl converts it to
 * this same-sized public record.  The first 88 bytes carry WasmStat's
 * filesystem metadata and the final three fields are initialized explicitly,
 * even when the filesystem does not yet provide them.
 *
 * The complete layout MUST match crates/shared/src/process_layout.rs.
 */

struct stat {
	unsigned long long st_dev;          /* offset  0 */
	unsigned long long st_ino;          /* offset  8 */
	unsigned int       st_mode;         /* offset 16 */
	unsigned int       st_nlink;        /* offset 20 */
	unsigned int       st_uid;          /* offset 24 */
	unsigned int       st_gid;          /* offset 28 */
	long long          st_size;         /* offset 32 */
	struct timespec    st_atim;         /* offset 40  (16 bytes on wasm64) */
	struct timespec    st_mtim;         /* offset 56  (16 bytes) */
	struct timespec    st_ctim;         /* offset 72  (16 bytes) */
	/* --- end of the kernel's internal WasmStat prefix (88 bytes) --- */
	unsigned long long st_rdev;         /* offset 88 */
	int                st_blksize;      /* offset 96 */
	long long          st_blocks;       /* offset 104 */
};

/* The layout constants come from crates/shared/src/process_layout.rs via
 * `cargo xtask dump-abi`. Asserting against those macros rather than against
 * literals is the point: the previous form compared musl to hand-written
 * numbers, so a change to the Rust authority left both sides asserting the
 * old value at each other. This is the pattern libc/glue/channel_syscall.c
 * already uses for siginfo_t. */
#include <bits/kandelo_process_layouts.h>

_Static_assert(sizeof(struct stat) == KANDELO_PROCESS_STAT_SIZE,
	"struct stat size drifted from crates/shared/src/process_layout.rs");
_Static_assert(__builtin_offsetof(struct stat, st_dev) == KANDELO_PROCESS_STAT_DEV_OFFSET,
	"st_dev offset drifted from crates/shared/src/process_layout.rs");
_Static_assert(__builtin_offsetof(struct stat, st_ino) == KANDELO_PROCESS_STAT_INO_OFFSET,
	"st_ino offset drifted from crates/shared/src/process_layout.rs");
_Static_assert(__builtin_offsetof(struct stat, st_mode) == KANDELO_PROCESS_STAT_MODE_OFFSET,
	"st_mode offset drifted from crates/shared/src/process_layout.rs");
_Static_assert(__builtin_offsetof(struct stat, st_nlink) == KANDELO_PROCESS_STAT_NLINK_OFFSET,
	"st_nlink offset drifted from crates/shared/src/process_layout.rs");
_Static_assert(__builtin_offsetof(struct stat, st_uid) == KANDELO_PROCESS_STAT_UID_OFFSET,
	"st_uid offset drifted from crates/shared/src/process_layout.rs");
_Static_assert(__builtin_offsetof(struct stat, st_gid) == KANDELO_PROCESS_STAT_GID_OFFSET,
	"st_gid offset drifted from crates/shared/src/process_layout.rs");
_Static_assert(__builtin_offsetof(struct stat, st_size) == KANDELO_PROCESS_STAT_SIZE_OFFSET,
	"st_size offset drifted from crates/shared/src/process_layout.rs");
_Static_assert(__builtin_offsetof(struct stat, st_atim) == KANDELO_PROCESS_STAT_ATIME_SEC_OFFSET,
	"st_atim offset drifted from crates/shared/src/process_layout.rs");
_Static_assert(__builtin_offsetof(struct stat, st_mtim) == KANDELO_PROCESS_STAT_MTIME_SEC_OFFSET,
	"st_mtim offset drifted from crates/shared/src/process_layout.rs");
_Static_assert(__builtin_offsetof(struct stat, st_ctim) == KANDELO_PROCESS_STAT_CTIME_SEC_OFFSET,
	"st_ctim offset drifted from crates/shared/src/process_layout.rs");
_Static_assert(__builtin_offsetof(struct stat, st_rdev) == KANDELO_PROCESS_STAT_RDEV_OFFSET,
	"st_rdev offset drifted from crates/shared/src/process_layout.rs");
_Static_assert(__builtin_offsetof(struct stat, st_blksize) == KANDELO_PROCESS_STAT_BLKSIZE_OFFSET,
	"st_blksize offset drifted from crates/shared/src/process_layout.rs");
_Static_assert(__builtin_offsetof(struct stat, st_blocks) == KANDELO_PROCESS_STAT_BLOCKS_OFFSET,
	"st_blocks offset drifted from crates/shared/src/process_layout.rs");
