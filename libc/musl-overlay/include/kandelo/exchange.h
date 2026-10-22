/* Kandelo exchange: moving files into and out of a running machine.
 *
 * The exchange filesystem is mounted at /run/kandelo/exchange on every
 * machine (see docs/architecture.md, "Kandelo exchange"). Everything here is
 * ordinary POSIX plus Linux-style user.* extended attributes; these helpers
 * only spell the conventions. Header-only: libc gains no symbols.
 *
 * Errors are reported the usual way: -1 (or NULL) with errno set. */
#ifndef _KANDELO_EXCHANGE_H
#define _KANDELO_EXCHANGE_H

#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/xattr.h>
#include <unistd.h>

#define KX_MOUNT "/run/kandelo/exchange"
#define KX_EVENTS KX_MOUNT "/events"
#define KX_INBOX KX_MOUNT "/inbox"
#define KX_WORK KX_MOUNT "/work"
#define KX_CLONE KX_MOUNT "/work/clone"
#define KX_OUTBOX KX_MOUNT "/outbox"
/* The agent the kernel starts on demand; an executable here means the
 * machine accepts files. */
#define KX_AGENT_PATH "/usr/libexec/kandelo/exchange-agent"
/* statfs f_type of the exchange filesystem: ASCII "KXCH". */
#define KX_FS_MAGIC 0x4B584348
/* The group whose members receive inputs and publish outputs. */
#define KX_GID 120

/* Extended attribute names. */
#define KX_XATTR_ID "user.kandelo.id"
#define KX_XATTR_SOURCE "user.kandelo.source"
#define KX_XATTR_STATUS "user.kandelo.status"
#define KX_XATTR_DERIVED_FROM "user.kandelo.derived_from"
#define KX_XATTR_END "user.kandelo.end"
#define KX_XATTR_INDEX "user.kandelo.index"
#define KX_XATTR_ORIGINAL_NAME "user.kandelo.original_name"
#define KX_XATTR_MIME_TYPE "user.mime_type"
#define KX_XATTR_ORIGIN_URL "user.xdg.origin.url"

/* An exchange ID in canonical form, plus its NUL. */
#define KX_ID_SIZE 37

/* Open a work session: the directory work/<n>/, owned by the caller, exists
 * until the returned descriptor's last reference goes (close, exit, even
 * SIGKILL), and everything unpublished in it goes with it. The descriptor is
 * close-on-exec. Writes the session directory's path to `path`. */
static inline int kx_session_open(char *path, size_t path_size)
{
	char number[16];
	ssize_t n;
	int fd = open(KX_CLONE, O_RDONLY | O_CLOEXEC);
	if (fd < 0) return -1;
	n = read(fd, number, sizeof number - 1);
	if (n <= 0 || number[n - 1] != '\n') {
		int saved = n < 0 ? errno : EIO;
		close(fd);
		errno = saved;
		return -1;
	}
	number[n - 1] = '\0';
	if ((size_t)snprintf(path, path_size, KX_WORK "/%s", number) >= path_size) {
		close(fd);
		errno = ENAMETOOLONG;
		return -1;
	}
	return fd;
}

/* Publish `staged`, a regular file or FIFO in a session, as outbox/<name>:
 * the rename is atomic, the output is then frozen and gets its own ID,
 * written to `id` (KX_ID_SIZE bytes) when `id` is not NULL. Fails with
 * ENXIO when no host takes outputs, EBUSY while the file is open, EEXIST
 * for a name already published. */
static inline int kx_publish(const char *staged, const char *name, char *id)
{
	char target[512];
	ssize_t n;
	if (strchr(name, '/') || !*name) {
		errno = EINVAL;
		return -1;
	}
	if ((size_t)snprintf(target, sizeof target, KX_OUTBOX "/%s", name) >= sizeof target) {
		errno = ENAMETOOLONG;
		return -1;
	}
	if (rename(staged, target) != 0) return -1;
	if (!id) return 0;
	n = getxattr(target, KX_XATTR_ID, id, KX_ID_SIZE - 1);
	if (n < 0) return -1;
	id[n] = '\0';
	return 0;
}

/* Declare how a published stream ended, before closing it: complete, or
 * aborted with a one-line reason of at most 256 bytes. Set once; later
 * writes to the stream fail with EPERM. */
static inline int kx_stream_end(const char *published, const char *abort_reason)
{
	char value[300];
	if (!abort_reason) return setxattr(published, KX_XATTR_END, "complete", 8, 0);
	if ((size_t)snprintf(value, sizeof value, "aborted %s", abort_reason) >= sizeof value) {
		errno = E2BIG;
		return -1;
	}
	return setxattr(published, KX_XATTR_END, value, strlen(value), 0);
}

#endif
