/* exchange-save: the catch-all `99-save` handler.
 *
 *   exchange-save BATCH_DIR
 *
 * Copies each top-level entry of the batch into ~/Downloads (creating it),
 * keeping folder structure. A FIFO entry (a host stream) is read to
 * end-of-file into a regular file; if the stream fails, the partial file is
 * removed and the batch fails. Names that collide get " (2)", " (3)", ...
 * before the extension. The batch status says where things went. Extended
 * attributes are not carried over: the root filesystem stores none. */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <kandelo/exchange.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/xattr.h>
#include <unistd.h>

#include "kx-util.h"

static char failure[256];

static void failed(const char *what, const char *path)
{
	if (!failure[0]) {
		if (errno == ENOSPC) snprintf(failure, sizeof failure, "failed: no space left on device");
		else snprintf(failure, sizeof failure, "failed: %s %s: %s", what, path, strerror(errno));
	}
}

static int copy_bytes(const char *from, const char *to, mode_t mode)
{
	char buffer[65536];
	ssize_t n;
	int in = open(from, O_RDONLY), out;
	if (in < 0) {
		failed("open", from);
		return -1;
	}
	out = open(to, O_WRONLY | O_CREAT | O_EXCL, mode);
	if (out < 0) {
		failed("create", to);
		close(in);
		return -1;
	}
	while ((n = read(in, buffer, sizeof buffer)) > 0) {
		if (kx_write_all(out, buffer, (size_t)n) != 0) {
			failed("write", to);
			break;
		}
	}
	if (n < 0) failed("read", from);
	close(in);
	if (close(out) != 0 && !failure[0]) failed("write", to);
	if (n != 0 || failure[0]) {
		unlink(to); /* never leave a truncated copy that looks finished */
		return -1;
	}
	return 0;
}

static int copy_tree(const char *from, const char *to)
{
	struct stat st;
	if (lstat(from, &st) != 0) {
		failed("stat", from);
		return -1;
	}
	if (S_ISDIR(st.st_mode)) {
		DIR *dir;
		struct dirent *entry;
		int rc = 0;
		if (mkdir(to, 0755) != 0) {
			failed("create", to);
			return -1;
		}
		dir = opendir(from);
		if (!dir) {
			failed("open", from);
			return -1;
		}
		while ((entry = readdir(dir))) {
			char a[1024], b[1024];
			if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
			snprintf(a, sizeof a, "%s/%s", from, entry->d_name);
			snprintf(b, sizeof b, "%s/%s", to, entry->d_name);
			if (copy_tree(a, b) != 0) rc = -1;
		}
		closedir(dir);
		return rc;
	}
	if (S_ISREG(st.st_mode) || S_ISFIFO(st.st_mode)) return copy_bytes(from, to, 0644);
	errno = EINVAL;
	failed("copy", from);
	return -1;
}

/* `downloads/name`, or `name (2).ext`, ... if taken. The suffix always fits:
 * a long stem is shortened (at a UTF-8 boundary) so the candidate stays
 * within NAME_MAX, and so every candidate differs. */
static int free_name(const char *downloads, const char *name, char *out, size_t size, char *chosen, size_t chosen_size)
{
	const char *dot = strrchr(name, '.');
	size_t stem = dot && dot != name ? (size_t)(dot - name) : strlen(name);
	const char *ext = dot && dot != name ? dot : "";
	struct stat st;
	snprintf(chosen, chosen_size, "%s", name);
	for (int n = 2; n < 100000; n++) {
		if ((size_t)snprintf(out, size, "%s/%s", downloads, chosen) >= size) {
			errno = ENAMETOOLONG;
			return -1;
		}
		if (lstat(out, &st) != 0) return 0;
		char suffix[16];
		int suffix_length = snprintf(suffix, sizeof suffix, " (%d)", n);
		size_t ext_length = strlen(ext);
		size_t room = 255 > ext_length + (size_t)suffix_length ? 255 - ext_length - (size_t)suffix_length : 0;
		size_t keep = stem < room ? stem : room;
		while (keep > 0 && ((unsigned char)name[keep] & 0xC0) == 0x80) keep--;
		snprintf(chosen, chosen_size, "%.*s%s%s", (int)keep, name, suffix, ext);
	}
	errno = EEXIST;
	return -1;
}

int main(int argc, char **argv)
{
	char downloads[512], status[512];
	const char *home = getenv("HOME");
	struct passwd *pw;
	DIR *dir;
	struct dirent *entry;
	int saved = 0, rc = 0;
	char last[256] = "";

	if (argc < 2) {
		fprintf(stderr, "usage: %s BATCH_DIR\n", argv[0]);
		return 64;
	}
	if (!home || !*home) {
		pw = getpwuid(getuid());
		home = pw ? pw->pw_dir : NULL;
	}
	if (!home) {
		fprintf(stderr, "exchange-save: no home directory\n");
		return 1;
	}
	snprintf(downloads, sizeof downloads, "%s/Downloads", home);
	if (mkdir(downloads, 0755) != 0 && errno != EEXIST) {
		failed("create", downloads);
		rc = 1;
	}
	dir = rc ? NULL : opendir(argv[1]);
	if (!rc && !dir) {
		failed("open", argv[1]);
		rc = 1;
	}
	while (dir && (entry = readdir(dir))) {
		char from[1024], to[1024], chosen[256];
		if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
		snprintf(from, sizeof from, "%s/%s", argv[1], entry->d_name);
		if (free_name(downloads, entry->d_name, to, sizeof to, chosen, sizeof chosen) != 0) {
			failed("name", entry->d_name);
			rc = 1;
			break;
		}
		if (copy_tree(from, to) != 0) {
			rc = 1;
			break;
		}
		saved++;
		snprintf(last, sizeof last, "%s", chosen);
	}
	if (dir) closedir(dir);

	if (rc) snprintf(status, sizeof status, "%s", failure[0] ? failure : "failed");
	else if (saved == 1) snprintf(status, sizeof status, "saved to ~/Downloads/%s", last);
	else snprintf(status, sizeof status, "saved %d items to ~/Downloads/", saved);
	/* A status is at most 256 bytes of UTF-8: cut a long name, never a
	 * character. */
	size_t length = strlen(status);
	if (length > 256) {
		length = 256;
		while (length > 0 && (status[length] & 0xC0) == 0x80) length--;
		status[length] = '\0';
	}
	if (setxattr(argv[1], KX_XATTR_STATUS, status, length, 0) != 0)
		fprintf(stderr, "exchange-save: cannot set status: %s\n", strerror(errno));
	if (rc) fprintf(stderr, "exchange-save: %s\n", status);
	return rc;
}
