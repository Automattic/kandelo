/* Wasm is single-threaded for now. Provide a minimal __get_tp(). */

/*
 * Return a pointer to a static block that acts as the thread pointer.
 * This is sufficient for single-threaded operation. The struct pthread
 * is laid out ending at the TP address (TLS_ABOVE_TP not set).
 * The block must be large enough to hold struct pthread (~200 bytes).
 */
static inline uintptr_t __get_tp(void)
{
    static unsigned long __wasm_tp_storage[64];
    return (uintptr_t)__wasm_tp_storage;
}

/* Machine context "program counter" — just a placeholder field name
 * used by pthread_cancel.c to read/write the saved PC in ucontext. */
#define MC_PC __mc_pc
