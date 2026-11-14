#include <stdint.h>
#define EXPORT(name) __attribute__((export_name(name)))
static uint32_t initialized[4] = { 3, 7, 11, 19 };
EXPORT("initial_data") uint32_t initial_data(void) { return initialized[0] + initialized[1] + initialized[2] + initialized[3]; }
EXPORT("mutate_data") void mutate_data(uint32_t x) { initialized[0] = x; }
EXPORT("load32") uint32_t load32(uint32_t p) { uint32_t x; __builtin_memcpy(&x, (void *)(uintptr_t)p, 4); return x; }
EXPORT("store32") void store32(uint32_t p, uint32_t x) { __builtin_memcpy((void *)(uintptr_t)p, &x, 4); }
EXPORT("copy") void copy(uint32_t d, uint32_t s, uint32_t n) { __builtin_memmove((void *)(uintptr_t)d, (void *)(uintptr_t)s, n); }
EXPORT("fill") void fill(uint32_t d, uint32_t x, uint32_t n) { __builtin_memset((void *)(uintptr_t)d, x, n); }
EXPORT("size") uint32_t size(void) { return __builtin_wasm_memory_size(0); }
EXPORT("grow") uint32_t grow(uint32_t n) { return __builtin_wasm_memory_grow(0,n); }
EXPORT("atomic_add") uint32_t atomic_add(uint32_t p, uint32_t x) { return __atomic_fetch_add((uint32_t *)(uintptr_t)p, x, __ATOMIC_SEQ_CST); }
__attribute__((noinline)) static uint32_t stack_use(uint32_t x) {
    volatile uint32_t stack[64];
    for (uint32_t i = 0; i < 64; i++) stack[i] = x + i;
    uint32_t sum = 0;
    for (uint32_t i = 0; i < 64; i++) sum += stack[i];
    return sum;
}
EXPORT("stack") uint32_t stack(uint32_t x) { return stack_use(x); }
