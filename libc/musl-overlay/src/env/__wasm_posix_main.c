#include <stdlib.h>

extern char **environ;

extern int __main_argc_argv(int, char **) __attribute__((weak));
extern int __main_void(void) __attribute__((weak));
extern int main(int, char **, char **) __attribute__((weak));

int __wasm_posix_main(int argc, char **argv)
{
	if (__main_argc_argv) return __main_argc_argv(argc, argv);
	if (__main_void) return __main_void();
	if (main) return main(argc, argv, environ);
	_Exit(127);
}
