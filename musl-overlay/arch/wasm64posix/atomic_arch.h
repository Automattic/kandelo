#define a_cas a_cas
static inline int a_cas(volatile int *p, int t, int s) {
    return __sync_val_compare_and_swap(p, t, s);
}

/* 64-bit pointer CAS for wasm64 (pointers are 8 bytes) */
#define a_cas_p a_cas_p
static inline void *a_cas_p(volatile void *p, void *t, void *s) {
    return (void *)__sync_val_compare_and_swap((volatile long long *)p, (long long)t, (long long)s);
}
