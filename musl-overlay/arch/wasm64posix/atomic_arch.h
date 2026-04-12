#define a_cas a_cas
static inline int a_cas(volatile int *p, int t, int s) {
    return __sync_val_compare_and_swap(p, t, s);
}

#define a_cas_p a_cas_p
static inline void *a_cas_p(volatile void *p, void *t, void *s) {
    return (void *)__sync_val_compare_and_swap((void *volatile *)p, t, s);
}

#define a_or_l a_or_l
static inline void a_or_l(volatile void *p, long v) {
    __sync_fetch_and_or((volatile long *)p, v);
}

#define a_and_64 a_and_64
static inline void a_and_64(volatile __UINT64_TYPE__ *p, __UINT64_TYPE__ v) {
    __sync_fetch_and_and(p, v);
}

#define a_or_64 a_or_64
static inline void a_or_64(volatile __UINT64_TYPE__ *p, __UINT64_TYPE__ v) {
    __sync_fetch_and_or(p, v);
}
