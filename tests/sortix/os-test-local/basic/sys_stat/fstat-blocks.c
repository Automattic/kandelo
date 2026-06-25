#include <sys/stat.h>

#include <fcntl.h>
#include <stdint.h>
#include <unistd.h>

#include "../basic.h"

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
	if ( fstat(fd, &st) < 0 )
		err(1, "fstat");

	if ( st.st_size != 1048576 )
		errx(1, "st_size was %jd, expected 1048576", (intmax_t) st.st_size);
	if ( st.st_blksize <= 0 )
		errx(1, "st_blksize was %jd, expected a positive block size", (intmax_t) st.st_blksize);
	if ( st.st_blocks < 2048 )
		errx(1, "st_blocks was %jd, expected at least 2048 512-byte blocks", (intmax_t) st.st_blocks);

	if ( close(fd) < 0 )
		err(1, "close");
	if ( unlink(path) < 0 )
		err(1, "unlink");
	return 0;
}
