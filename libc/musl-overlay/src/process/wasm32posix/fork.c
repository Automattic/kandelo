/*
 * fork() for wasm32posix — simplified version for single-threaded Wasm.
 *
 * Skips thread-related lock handling since Wasm instances are single-threaded,
 * but calls __fork_handler to invoke pthread_atfork registered handlers.
 */

#include <unistd.h>

pid_t _Fork(void);
void __fork_handler(int);
weak void __kandelo_loader_atfork(int);

pid_t fork(void)
{
	__fork_handler(-1);
	if (__kandelo_loader_atfork) __kandelo_loader_atfork(-1);
	pid_t ret = _Fork();
	if (__kandelo_loader_atfork) __kandelo_loader_atfork(!ret);
	__fork_handler(!ret);
	return ret;
}
