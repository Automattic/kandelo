#define a_cas a_cas
static inline int a_cas(volatile int *p, int t, int s) {
    return __sync_val_compare_and_swap(p, t, s);
}

/* a_crash: must actually trap. The musl generic fallback writes to
 * address 0, but on wasm32 address 0 is the start of valid linear
 * memory — the write succeeds silently. That makes every mallocng /
 * pthread / stdio assertion a no-op, masking real bugs (e.g.
 * mariadbd's atexit double-free) until corrupt state propagates and
 * something else traps with "memory access out of bounds" much later.
 * __builtin_trap() lowers to wasm `unreachable`, which is the proper
 * abort: the wasm runtime turns it into a RuntimeError immediately at
 * the assertion site. */
#define a_crash a_crash
static inline _Noreturn void a_crash(void) {
    __builtin_trap();
}
