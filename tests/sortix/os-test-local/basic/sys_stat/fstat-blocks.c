#include <sys/stat.h>

#include <fcntl.h>
#include <stdint.h>
#include <unistd.h>

#include "../basic.h"

static __attribute__((noinline)) void dirty_stack(void)
{
	volatile unsigned char scratch[4096];
	for ( size_t i = 0; i < sizeof(scratch); i++ )
		scratch[i] = 0x6a;
}

static void check_stat_block_fields(const char* label, const struct stat* st)
{
	if ( st->st_size != 1048576 )
		errx(1, "%s: st_size was %jd, expected 1048576", label, (intmax_t) st->st_size);
	if ( st->st_blksize <= 0 || st->st_blksize > 1048576 )
		errx(1, "%s: st_blksize was %jd, expected a sane positive block size", label, (intmax_t) st->st_blksize);
	if ( st->st_blocks < 2048 )
		errx(1, "%s: st_blocks was %jd, expected at least 2048 512-byte blocks", label, (intmax_t) st->st_blocks);
}

int main(void)
{
	const char path[] = "fstat-blocks.tmp";
	int fd = open(path, O_CREAT | O_TRUNC | O_RDWR, 0600);
	if ( fd < 0 )
		err(1, "open");

	char byte = 0;
	if ( pwrite(fd, &byte, 1, 1048576 - 1) != 1 )
		err(1, "pwrite");

	struct stat st;
	dirty_stack();
	if ( fstat(fd, &st) < 0 )
		err(1, "fstat");
	check_stat_block_fields("fstat", &st);

	dirty_stack();
	if ( stat(path, &st) < 0 )
		err(1, "stat");
	check_stat_block_fields("stat", &st);

	dirty_stack();
	if ( lstat(path, &st) < 0 )
		err(1, "lstat");
	check_stat_block_fields("lstat", &st);

	if ( close(fd) < 0 )
		err(1, "close");
	if ( unlink(path) < 0 )
		err(1, "unlink");
	return 0;
}
