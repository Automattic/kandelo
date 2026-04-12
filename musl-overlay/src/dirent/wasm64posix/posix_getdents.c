#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include "syscall.h"

/* posix_dent layout matching the overlay dirent.h:
 *   ino_t d_ino             (8 bytes on wasm32)
 *   unsigned short d_reclen (2 bytes)
 *   unsigned char d_type    (1 byte)
 *   char d_name[]           (flexible, null-terminated)
 */
#define PD_INO_OFF    0
#define PD_RECLEN_OFF 8
#define PD_TYPE_OFF   10
#define PD_NAME_OFF   11

ssize_t posix_getdents(int fd, void *buf, size_t bufsize, int flags)
{
	if (flags != 0) {
		errno = EINVAL;
		return -1;
	}

	/*
	 * Read one linux_dirent64 entry at a time from the kernel.
	 * We can't buffer multiple entries because the kernel advances
	 * the directory cursor, and the caller's buffer may only fit
	 * one posix_dent.
	 *
	 * linux_dirent64 layout:
	 *   u64  d_ino     (8)
	 *   i64  d_off     (8)
	 *   u16  d_reclen  (2)
	 *   u8   d_type    (1)
	 *   char d_name[]  (null-terminated, padded to 8-byte alignment)
	 *
	 * The minimum linux_dirent64 for name "." is 19+2 rounded to 8 = 24 bytes.
	 * Use bufsize as the kernel buffer to naturally limit entries.
	 */
	unsigned char tmp[4096];
	size_t tmp_size = bufsize < sizeof(tmp) ? bufsize : sizeof(tmp);
	long ret = __syscall(SYS_getdents64, fd, tmp, tmp_size);
	if (ret < 0) {
		errno = -ret;
		return -1;
	}
	if (ret == 0)
		return 0;

	unsigned char *out = buf;
	size_t out_pos = 0;
	size_t in_pos = 0;

	while (in_pos < (size_t)ret) {
		/* Parse linux_dirent64 */
		uint64_t d_ino;
		uint16_t d_reclen;
		uint8_t d_type;

		memcpy(&d_ino, tmp + in_pos, 8);
		memcpy(&d_reclen, tmp + in_pos + 16, 2);
		d_type = tmp[in_pos + 18];
		const char *name = (const char *)(tmp + in_pos + 19);
		size_t name_len = strlen(name);

		/* Compute posix_dent size:
		 * PD_NAME_OFF + name_len + 1 (NUL), aligned to 8 bytes */
		size_t pd_reclen = (PD_NAME_OFF + name_len + 1 + 7) & ~(size_t)7;

		if (out_pos + pd_reclen > bufsize)
			break;

		/* Write posix_dent */
		memcpy(out + out_pos + PD_INO_OFF, &d_ino, 8);
		uint16_t reclen16 = (uint16_t)pd_reclen;
		memcpy(out + out_pos + PD_RECLEN_OFF, &reclen16, 2);
		out[out_pos + PD_TYPE_OFF] = d_type;
		memcpy(out + out_pos + PD_NAME_OFF, name, name_len + 1);
		/* Zero padding */
		size_t end = PD_NAME_OFF + name_len + 1;
		while (end < pd_reclen)
			out[out_pos + end++] = 0;

		out_pos += pd_reclen;
		in_pos += d_reclen;
	}

	if (out_pos == 0) {
		errno = EINVAL;
		return -1;
	}

	return (ssize_t)out_pos;
}
