#include <sys/stat.h>

#include <fcntl.h>
#include <inttypes.h>
#include <unistd.h>

#include "../basic.h"

static __attribute__((noinline)) void dirty_stack(void)
{
	volatile unsigned char scratch[4096];
	for ( size_t i = 0; i < sizeof(scratch); i++ )
		scratch[i] = 0x6a;
}

static void check_unreported_fields(const char* label, const struct stat* st)
{
	if ( st->st_rdev != 0 )
		errx(1, "%s: st_rdev was %ju, expected 0", label,
		     (uintmax_t) st->st_rdev);
	if ( st->st_blksize != 0 )
		errx(1, "%s: st_blksize was %jd, expected 0", label,
		     (intmax_t) st->st_blksize);
	if ( st->st_blocks != 0 )
		errx(1, "%s: st_blocks was %jd, expected 0", label,
		     (intmax_t) st->st_blocks);
}

int main(void)
{
	const char path[] = "stat-unreported-fields.tmp";
	int fd = open(path, O_CREAT | O_TRUNC | O_RDWR, 0600);
	if ( fd < 0 )
		err(1, "open");

	char byte = 0;
	if ( write(fd, &byte, 1) != 1 )
		err(1, "write");

	struct stat st;
	dirty_stack();
	if ( fstat(fd, &st) < 0 )
		err(1, "fstat");
	check_unreported_fields("fstat", &st);

	dirty_stack();
	if ( stat(path, &st) < 0 )
		err(1, "stat");
	check_unreported_fields("stat", &st);

	dirty_stack();
	if ( lstat(path, &st) < 0 )
		err(1, "lstat");
	check_unreported_fields("lstat", &st);

	if ( close(fd) < 0 )
		err(1, "close");
	if ( unlink(path) < 0 )
		err(1, "unlink");
	return 0;
}
