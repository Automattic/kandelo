#define _GNU_SOURCE
#include <spawn.h>

int posix_spawn_file_actions_addfchdir(posix_spawn_file_actions_t *fa, int fd)
{
	return posix_spawn_file_actions_addfchdir_np(fa, fd);
}
