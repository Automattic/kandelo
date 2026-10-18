/* bits/stat.h — wasm64posix struct stat
 *
 * The kernel writes a complete 112-byte native kstat and musl converts it to
 * this same-sized public record.  The first 96 bytes carry WasmStat's
 * filesystem metadata through st_rdev — a Linux-encoded dev_t for device
 * nodes (e.g. /dev/input/event0 = 13:64), 0 otherwise. The final two
 * fields are initialized explicitly, even when the filesystem does not
 * yet provide them.
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
	unsigned long long st_rdev;         /* offset 88, from kernel WasmStat */
	/* --- end of the kernel's WasmStat prefix (96 bytes) --- */
	int                st_blksize;      /* offset 96 */
	long long          st_blocks;       /* offset 104 */
};

_Static_assert(sizeof(struct stat) == 112, "struct stat size mismatch");
_Static_assert(__builtin_offsetof(struct stat, st_size) == 32,
	"st_size offset mismatch");
_Static_assert(__builtin_offsetof(struct stat, st_atim) == 40,
	"st_atim offset mismatch");
_Static_assert(__builtin_offsetof(struct stat, st_mtim) == 56,
	"st_mtim offset mismatch");
_Static_assert(__builtin_offsetof(struct stat, st_ctim) == 72,
	"st_ctim offset mismatch");
_Static_assert(__builtin_offsetof(struct stat, st_rdev) == 88,
	"st_rdev offset mismatch");
_Static_assert(__builtin_offsetof(struct stat, st_blksize) == 96,
	"st_blksize offset mismatch");
_Static_assert(__builtin_offsetof(struct stat, st_blocks) == 104,
	"st_blocks offset mismatch");
