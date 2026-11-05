/* Signal integration for runtimes that submit their own Kandelo syscalls. */
#ifndef _KANDELO_SIGNAL_H
#define _KANDELO_SIGNAL_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Consume the calling thread's already delivered channel signal through
 * libc's handler, siginfo, alternate-stack, and mask-restoration path.
 * Save the original syscall result and reset its channel to IDLE first.
 * Returns the delivered action flags, or zero if no signal was present.
 * This does not restart the original syscall or establish a deadline. */
uint32_t __wasm_posix_dispatch_pending_signal(void);

#ifdef __cplusplus
}
#endif

#endif
