#include <errno.h>
#include <limits.h>
#include <stdlib.h>

#include "syscall.h"

char *realpath(const char *restrict filename, char *restrict resolved)
{
	char *output = resolved;
	int allocated = 0;

	if (!filename) {
		errno = EINVAL;
		return 0;
	}
	if (!output) {
		output = malloc(PATH_MAX);
		if (!output) return 0;
		allocated = 1;
	}

	/* WHY: Kandelo's kernel already owns the authoritative namespace walker.
	 * Upstream musl resolves each component with a separate readlink syscall;
	 * across the Wasm syscall channel that repeats process/kernel handoffs for
	 * every ordinary non-symlink component. One existing realpath syscall keeps
	 * the same POSIX-visible lookup, permission, mount, and symlink semantics in
	 * the owning kernel while leaving one byte for libc's terminating NUL. */
	long length = __syscall(SYS_realpath, filename, output, PATH_MAX - 1);
	if (length < 0) {
		if (allocated) free(output);
		errno = length == -ERANGE ? ENAMETOOLONG : (int)-length;
		return 0;
	}
	if (length >= PATH_MAX) {
		if (allocated) free(output);
		errno = ENAMETOOLONG;
		return 0;
	}
	output[length] = 0;
	return output;
}
