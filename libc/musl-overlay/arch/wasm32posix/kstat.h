/* kstat.h — kernel stat format for wasm32posix.
 *
 * This matches the kernel's WasmStat layout (88 bytes) exactly.
 * musl's fstatat.c copies from kstat fields to struct stat fields.
 *
 * The kernel fills all 88 bytes. The rdev/blksize/blocks fields
 * are appended for musl compatibility but the kernel doesn't fill them.
 */
struct kstat {
	unsigned long long st_dev;          /* offset  0, 8 bytes */
	unsigned long long st_ino;          /* offset  8, 8 bytes */
	unsigned int       st_mode;         /* offset 16, 4 bytes */
	unsigned int       st_nlink;        /* offset 20, 4 bytes */
	unsigned int       st_uid;          /* offset 24, 4 bytes */
	unsigned int       st_gid;          /* offset 28, 4 bytes */
	unsigned long long st_size;         /* offset 32, 8 bytes */
	long long          st_atime_sec;    /* offset 40, 8 bytes */
	unsigned int       st_atime_nsec;   /* offset 48, 4 bytes */
	unsigned int       __atime_pad;     /* offset 52, 4 bytes */
	long long          st_mtime_sec;    /* offset 56, 8 bytes */
	unsigned int       st_mtime_nsec;   /* offset 64, 4 bytes */
	unsigned int       __mtime_pad;     /* offset 68, 4 bytes */
	long long          st_ctime_sec;    /* offset 72, 8 bytes */
	unsigned int       st_ctime_nsec;   /* offset 80, 4 bytes */
	unsigned int       __ctime_pad;     /* offset 84, 4 bytes */
	/* --- end of 88-byte WasmStat --- */
	unsigned long long st_rdev;         /* not from kernel; stays 0 */
	int                st_blksize;      /* not from kernel; stays 0 */
	int                st_blocks;       /* not from kernel; stays 0 */
};
