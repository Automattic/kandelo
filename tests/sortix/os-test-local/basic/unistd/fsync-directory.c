#include <sys/stat.h>

#include <fcntl.h>
#include <unistd.h>

#include "../basic.h"

int main(void)
{
	const char path[] = "fsync-directory.tmp";
	if ( mkdir(path, 0700) < 0 )
		err(1, "mkdir");

	int fd = open(path, O_RDONLY | O_DIRECTORY);
	if ( fd < 0 )
		err(1, "open");

	if ( fsync(fd) < 0 )
		err(1, "fsync");

	if ( close(fd) < 0 )
		err(1, "close");
	if ( rmdir(path) < 0 )
		err(1, "rmdir");
	return 0;
}
