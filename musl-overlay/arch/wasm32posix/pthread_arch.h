/*
 * Wasm per-thread thread pointer via _Thread_local.
 *
 * LLVM places _Thread_local variables relative to __tls_base, a
 * per-instance Wasm global. Each thread (separate Wasm Instance
 * sharing linear memory) gets its own copy automatically.
 *
 * The main thread sets __wasm_thread_pointer to point at __wasm_tp_storage.
 * Thread workers set it via __wasm_thread_init() before running.
 *
 * TLS_ABOVE_TP is not set, so TP points directly at struct pthread.
 */

extern unsigned long __wasm_tp_storage[64]; /* main thread backing storage */
extern _Thread_local unsigned long __wasm_thread_pointer;

static inline uintptr_t __get_tp(void)
{
    return (uintptr_t)__wasm_thread_pointer;
}

/* Machine context "program counter" — just a placeholder field name
 * used by pthread_cancel.c to read/write the saved PC in ucontext. */
#define MC_PC __mc_pc
