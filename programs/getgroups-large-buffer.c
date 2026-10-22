/* getgroups() with a buffer larger than NGROUPS_MAX.
 *
 * POSIX: getgroups fails with EINVAL only when gidsetsize is nonzero and
 * less than the number of supplementary groups. A buffer with room for more
 * than NGROUPS_MAX entries is always large enough and must succeed, writing
 * only the returned entries. Prints PASS and exits 0 if every check holds. */
#include <errno.h>
#include <grp.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static int failures;

static void check(const char *what, int ok)
{
	if (!ok) {
		fprintf(stderr, "FAIL %s (errno %d %s)\n", what, errno, strerror(errno));
		failures++;
	}
}

int main(void)
{
	gid_t set[3] = {41, 7, 120}, got[NGROUPS_MAX + 64];
	check("setgroups", setgroups(3, set) == 0);
	for (size_t i = 0; i < sizeof got / sizeof *got; i++) got[i] = 0xdead;
	int n = getgroups(NGROUPS_MAX + 64, got);
	check("a buffer larger than NGROUPS_MAX", n == 3);
	check("the entries", n == 3 && got[0] == 41 && got[1] == 7 && got[2] == 120);
	check("nothing past the entries", got[3] == 0xdead);
	check("NGROUPS_MAX + 1", getgroups(NGROUPS_MAX + 1, got) == 3);
	check("count query", getgroups(0, NULL) == 3);
	errno = 0;
	check("a short buffer is EINVAL", getgroups(2, got) == -1 && errno == EINVAL);
	errno = 0;
	gid_t many[NGROUPS_MAX + 1] = {0};
	check("setgroups beyond NGROUPS_MAX is EINVAL", setgroups(NGROUPS_MAX + 1, many) == -1 && errno == EINVAL);
	if (failures == 0) printf("PASS\n");
	return failures == 0 ? 0 : 1;
}
