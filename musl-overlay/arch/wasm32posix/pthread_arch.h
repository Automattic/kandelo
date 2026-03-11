/* Wasm is single-threaded for now. Provide a minimal __get_tp(). */

/*
 * Return a pointer to a global block that acts as the thread pointer.
 * This is sufficient for single-threaded operation. The struct pthread
 * is laid out starting at the TP address (TLS_ABOVE_TP not set).
 * The block must be large enough to hold struct pthread (~200 bytes).
 *
 * IMPORTANT: The storage is a single global symbol defined in
 * __wasm_tp.c, NOT a static local. Using a static local inside an
 * inline function would give each translation unit its own copy,
 * breaking locale and errno which are stored in the pthread struct.
 */
extern unsigned long __wasm_tp_storage[64];

static inline uintptr_t __get_tp(void)
{
    return (uintptr_t)__wasm_tp_storage;
}

/* Machine context "program counter" — just a placeholder field name
 * used by pthread_cancel.c to read/write the saved PC in ucontext. */
#define MC_PC __mc_pc
