/*
 * __wasm_tp.c -- Global thread-pointer storage for wasm32.
 *
 * __wasm_tp_storage is the backing memory for the main thread's
 * struct pthread. 64 unsigned longs = 256 bytes, more than enough
 * for struct pthread on wasm32 (~120 bytes).
 *
 * __wasm_thread_pointer is _Thread_local so LLVM places it relative
 * to __tls_base (a per-instance Wasm global), giving each thread its
 * own copy even when sharing linear memory.
 */

unsigned long __wasm_tp_storage[64];
_Thread_local unsigned long __wasm_thread_pointer;
