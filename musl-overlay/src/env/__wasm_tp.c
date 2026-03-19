/*
 * __wasm_tp.c -- Global thread-pointer storage for wasm32.
 *
 * __wasm_tp_storage is the backing memory for the main thread's
 * struct pthread. 64 unsigned longs = 256 bytes, more than enough
 * for struct pthread on wasm32 (~120 bytes).
 *
 * __wasm_thread_pointer is a mutable global that each Wasm Instance
 * gets its own copy of, making it naturally per-thread. The main
 * thread sets it to __wasm_tp_storage during __init_libc.
 */

unsigned long __wasm_tp_storage[64];
unsigned long __wasm_thread_pointer;
