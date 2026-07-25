/* Test posix_spawn with argv+environment larger than one 64 KiB channel. */

#include <sys/wait.h>

#include <err.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define ENV_COUNT 96
#define VALUE_BYTES 1024

static char value_byte(unsigned index)
{
	return (char) ('a' + index % 26);
}

static void environment_name(char* buffer, size_t size, unsigned index)
{
	int length = snprintf(buffer, size, "SPAWN_LARGE_%u", index);
	if ( length < 0 || (size_t) length >= size )
		errx(1, "environment name overflow");
}

static char* make_environment_entry(unsigned index)
{
	char name[32];
	environment_name(name, sizeof(name), index);
	size_t name_length = strlen(name);
	char* entry = malloc(name_length + 1 + VALUE_BYTES + 1);
	if ( !entry )
		err(1, "malloc");
	memcpy(entry, name, name_length);
	entry[name_length] = '=';
	memset(entry + name_length + 1, value_byte(index), VALUE_BYTES);
	entry[name_length + 1 + VALUE_BYTES] = '\0';
	return entry;
}

static void verify_child_environment(void)
{
	for (unsigned index = 0; index < ENV_COUNT; index++)
	{
		char name[32];
		environment_name(name, sizeof(name), index);
		const char* value = getenv(name);
		if ( !value )
			errx(1, "%s was not inherited", name);
		if ( strlen(value) != VALUE_BYTES )
			errx(1, "%s has length %zu, expected %u",
			     name, strlen(value), VALUE_BYTES);
		for (size_t offset = 0; offset < VALUE_BYTES; offset++)
		{
			if ( value[offset] != value_byte(index) )
				errx(1, "%s differs at byte %zu", name, offset);
		}
	}
}

int main(int argc, char* argv[])
{
	if ( argc == 2 )
	{
		if ( strcmp(argv[1], "child") != 0 )
			errx(1, "child invoked incorrectly");
		verify_child_environment();
		return 0;
	}

	char** environment = calloc(ENV_COUNT + 1, sizeof(char*));
	if ( !environment )
		err(1, "calloc");
	size_t environment_bytes = 0;
	for (unsigned index = 0; index < ENV_COUNT; index++)
	{
		environment[index] = make_environment_entry(index);
		environment_bytes += strlen(environment[index]) + 1;
	}
	if ( environment_bytes <= 65536 )
		errx(1, "test environment is only %zu bytes", environment_bytes);

	char* child_argv[] = { argv[0], "child", NULL };
	for (unsigned attempt = 0; attempt < 2; attempt++)
	{
		pid_t child_pid = 0;
		int error = posix_spawn(
			&child_pid,
			argv[0],
			NULL,
			NULL,
			child_argv,
			environment
		);
		if ( error )
			errx(1, "posix_spawn attempt %u: %s",
			     attempt + 1, strerror(error));

		int status = 0;
		if ( waitpid(child_pid, &status, 0) < 0 )
			err(1, "waitpid attempt %u", attempt + 1);
		if ( !WIFEXITED(status) )
			errx(1, "child attempt %u did not exit normally: %#x",
			     attempt + 1, status);
		if ( WEXITSTATUS(status) != 0 )
			errx(1, "child attempt %u exited with status %d",
			     attempt + 1, WEXITSTATUS(status));
	}

	for (unsigned index = 0; index < ENV_COUNT; index++)
		free(environment[index]);
	free(environment);
	return 0;
}
