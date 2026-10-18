/* kstat.h — kernel stat format for wasm32posix.
 *
 * This is the complete 112-byte native syscall result. The kernel's internal
 * WasmStat metadata record supplies the prefix through st_rdev (offset 88) —
 * a Linux-encoded dev_t for device nodes (e.g. /dev/input/event0 = 13:64),
 * 0 otherwise; its native serializer initializes the blksize/blocks suffix
 * to zero.
 *
 * Keeping the complete allocation explicit prevents a host copy-back sized
 * for struct kstat from exposing reused scratch bytes after the 96-byte
 * internal prefix. See #928 for truthful filesystem-provided suffix values.
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
	unsigned long long st_rdev;         /* offset 88, from kernel WasmStat.st_rdev */
	/* --- end of the internal 96-byte WasmStat prefix --- */
	int                st_blksize;      /* offset 96, zero until reported */
	int                __blocks_pad;    /* offset 100, initialized padding */
	long long          st_blocks;       /* offset 104, zero until reported */
};

_Static_assert(sizeof(struct kstat) == 112, "wasm32 kstat size mismatch");
_Static_assert(__builtin_offsetof(struct kstat, st_rdev) == 88,
	"wasm32 kstat st_rdev offset mismatch");
_Static_assert(__builtin_offsetof(struct kstat, st_blksize) == 96,
	"wasm32 kstat st_blksize offset mismatch");
_Static_assert(__builtin_offsetof(struct kstat, st_blocks) == 104,
	"wasm32 kstat st_blocks offset mismatch");
