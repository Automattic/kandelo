/* bits/stat.h — wasm64posix struct stat
 *
 * The kernel's WasmStat writes the first 88 bytes of this structure
 * (through st_ctim). The remaining fields (st_rdev, st_blksize,
 * st_blocks) are populated by musl's fstatat conversion logic or
 * remain zero.
 *
 * Field layout through st_ctim MUST match crates/shared/src/lib.rs.
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
	/* --- end of kernel WasmStat (88 bytes) --- */
	unsigned long long st_rdev;         /* offset 88 */
	int                st_blksize;      /* offset 96 */
	long long          st_blocks;       /* offset 100 (pad to 104? or 108) */
};

/* Key kernel-layout offsets must still match */
_Static_assert(__builtin_offsetof(struct stat, st_size) == 32,
	"st_size offset mismatch");
_Static_assert(__builtin_offsetof(struct stat, st_atim) == 40,
	"st_atim offset mismatch");
_Static_assert(__builtin_offsetof(struct stat, st_mtim) == 56,
	"st_mtim offset mismatch");
_Static_assert(__builtin_offsetof(struct stat, st_ctim) == 72,
	"st_ctim offset mismatch");
