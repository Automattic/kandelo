/* Small helpers shared by the kandelo-exchange programs. */
#ifndef KX_UTIL_H
#define KX_UTIL_H

#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* Remove `path` and everything below it, without following symlinks. */
static inline int kx_remove_tree(const char *path)
{
	struct stat st;
	if (lstat(path, &st) != 0) return errno == ENOENT ? 0 : -1;
	if (S_ISDIR(st.st_mode)) {
		DIR *dir = opendir(path);
		struct dirent *entry;
		int failed = 0;
		if (!dir) return -1;
		while ((entry = readdir(dir))) {
			char child[1024];
			if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
			if ((size_t)snprintf(child, sizeof child, "%s/%s", path, entry->d_name) >= sizeof child) {
				failed = 1;
				continue;
			}
			if (kx_remove_tree(child) != 0) failed = 1;
		}
		closedir(dir);
		if (rmdir(path) != 0) return -1;
		return failed ? -1 : 0;
	}
	return unlink(path);
}

/* Write all of `data` to `fd`. */
static inline int kx_write_all(int fd, const char *data, size_t length)
{
	while (length > 0) {
		ssize_t n = write(fd, data, length);
		if (n < 0) {
			if (errno == EINTR) continue;
			return -1;
		}
		data += n;
		length -= (size_t)n;
	}
	return 0;
}

#endif
