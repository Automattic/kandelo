/*
 * __wasm_tp.c -- Global thread-pointer storage for wasm32.
 *
 * Provides a single BSS block that serves as the struct pthread for
 * the main (only) thread.  Every translation unit that calls
 * __get_tp() (via pthread_arch.h) references this same symbol, so
 * fields like locale, errno_val, etc. are shared process-wide.
 *
 * 64 unsigned longs = 256 bytes, which is more than enough for
 * struct pthread on wasm32 (~120 bytes).
 */

unsigned long __wasm_tp_storage[64];
