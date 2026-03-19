/*
 * Wasm per-thread thread pointer via a C global variable.
 *
 * Each Wasm Instance has its own copy of global variables, making this
 * naturally per-thread when threads use separate Instances sharing
 * the same Memory.
 *
 * The main thread sets __wasm_thread_pointer to point at __wasm_tp_storage.
 * Thread workers set it via __wasm_thread_init() before running.
 *
 * TLS_ABOVE_TP is not set, so TP points directly at struct pthread.
 */

extern unsigned long __wasm_tp_storage[64]; /* main thread backing storage */
extern unsigned long __wasm_thread_pointer;

static inline uintptr_t __get_tp(void)
{
    return (uintptr_t)__wasm_thread_pointer;
}

/* Machine context "program counter" — just a placeholder field name
 * used by pthread_cancel.c to read/write the saved PC in ucontext. */
#define MC_PC __mc_pc
