#define _GNU_SOURCE
#include <spawn.h>

int posix_spawn_file_actions_addchdir(posix_spawn_file_actions_t *restrict fa, const char *restrict path)
{
	return posix_spawn_file_actions_addchdir_np(fa, path);
}
