#include <stdint.h>

// Trusted experimental address space. Root header: current pages, maximum
// pages, scatter-copy capacity, initialized. PTEs follow a 64-byte header.
// Mapping changes happen only while this process's sole Worker is stopped.
#define PAGE 65536u
#define HEADER 64u
#define AI static __inline__ __attribute__((always_inline))
#define EXPORT(name) __attribute__((export_name(name)))
AI uint32_t *words(uint32_t p) { return (uint32_t *)(uintptr_t)p; }
AI void fail(void) { __builtin_trap(); }
AI uint32_t effective(uint32_t p, uint64_t offset, uint32_t n, uint32_t root) {
    if (!root || offset > UINT32_MAX) fail();
    uint64_t q = (uint64_t)p + offset;
    uint64_t limit = (uint64_t)words(root)[0] * PAGE;
    if (q > limit || n > limit - q) fail();
    return (uint32_t)q;
}
AI uint32_t page(uint32_t p, uint32_t rights, uint32_t root) {
    uint32_t e = words(root + HEADER)[p >> 16];
    if ((e & rights) != rights || !(e & -PAGE)) fail();
    return (e & -PAGE) | (p & (PAGE - 1));
}
EXPORT("vm_span")
uint32_t vm_span(uint32_t p, uint32_t n, uint32_t rights, uint32_t root) {
    (void)effective(p, 0, n, root);
    if (!n) return 0;
    uint32_t first = page(p, rights, root), contiguous = 1;
    uint64_t end = (uint64_t)p + n;
    for (uint64_t q = ((uint64_t)p & -(uint64_t)PAGE) + PAGE; q < end; q += PAGE) {
        if (page((uint32_t)q, rights, root) != (uint64_t)first + q - p)
            contiguous = 0;
    }
    return contiguous ? first : 0;
}
EXPORT("vm_read_address")
uint32_t vm_read_address(uint32_t base, uint64_t offset, uint32_t n, uint32_t root, uint32_t scratch) {
    uint32_t p = effective(base, offset, n, root);
    uint32_t a = vm_span(p, n, 1, root);
    if (a) return a;
    if (n > 16) fail();
    for (uint32_t i = 0; i < n; i++)
        *(uint8_t *)(uintptr_t)(scratch + i) = *(uint8_t *)(uintptr_t)page(p + i, 1, root);
    return scratch;
}
EXPORT("vm_write_address")
uint32_t vm_write_address(uint32_t base, uint64_t offset, uint32_t n, uint32_t root, uint32_t scratch) {
    uint32_t p = effective(base, offset, n, root);
    uint32_t a = vm_span(p, n, 2, root);
    if (a) return a;
    if (n > 16) fail();
    return scratch;
}
EXPORT("vm_write_commit")
void vm_write_commit(uint32_t base, uint64_t offset, uint32_t n, uint32_t root, uint32_t scratch, uint32_t chosen) {
    if (chosen != scratch) return;
    uint32_t p = effective(base, offset, n, root);
    for (uint32_t i = 0; i < n; i++)
        *(uint8_t *)(uintptr_t)page(p + i, 2, root) = *(uint8_t *)(uintptr_t)(scratch + i);
}
EXPORT("vm_init_address")
uint32_t vm_init_address(uint32_t p, uint32_t n, uint32_t root, uint32_t scratch) {
    uint32_t a = vm_span(p, n, 2, root);
    if (a) return a;
    if (n > words(root)[2]) fail();
    return scratch;
}
EXPORT("vm_atomic_address")
uint32_t vm_atomic_address(uint32_t base, uint64_t offset, uint32_t n, uint32_t rights, uint32_t root) {
    uint32_t p = effective(base, offset, n, root);
    if (p & (n - 1)) fail();
    uint32_t a = vm_span(p, n, rights, root);
    if (!a) fail();
    return a;
}
EXPORT("vm_copy")
void vm_copy(uint32_t dst, uint32_t src, uint32_t n, uint32_t root, uint32_t scratch) {
    uint32_t s = vm_span(src, n, 1, root), d = vm_span(dst, n, 2, root);
    if (!n) return;
    if (s && d) {
        __builtin_memmove((void *)(uintptr_t)d, (void *)(uintptr_t)s, n);
        return;
    }
    // Full staging preserves aliases whose physical ordering differs from VA.
    if (n > words(root)[2]) fail();
    for (uint32_t i = 0; i < n; i++)
        *(uint8_t *)(uintptr_t)(scratch + i) = *(uint8_t *)(uintptr_t)page(src + i, 1, root);
    for (uint32_t i = 0; i < n; i++)
        *(uint8_t *)(uintptr_t)page(dst + i, 2, root) = *(uint8_t *)(uintptr_t)(scratch + i);
}
EXPORT("vm_fill")
void vm_fill(uint32_t dst, uint32_t value, uint32_t n, uint32_t root) {
    uint32_t d = vm_span(dst, n, 2, root);
    if (!n) return;
    if (d) { __builtin_memset((void *)(uintptr_t)d, value, n); return; }
    for (uint32_t i = 0; i < n; i++) *(uint8_t *)(uintptr_t)page(dst + i, 2, root) = value;
}
EXPORT("vm_size")
uint32_t vm_size(uint32_t root) { if (!root) fail(); return words(root)[0]; }
EXPORT("vm_initialize_gate")
uint32_t vm_initialize_gate(uint32_t root, uint32_t fresh) {
    if (!root || fresh > 1 || words(root)[3] || words(root)[0] > words(root)[1]) fail();
    words(root)[3] = 1;
    return fresh;
}
EXPORT("vm_grow")
uint32_t vm_grow(uint32_t delta, uint32_t root) {
    if (!root) fail();
    uint32_t old = words(root)[0];
    if (delta > words(root)[1] - old) return UINT32_MAX;
    if (!delta) return old;
    // Group allocator at reserved physical address 4096: lock, next page,
    // maximum pages. No extent reuse in this first bounded prototype.
    uint32_t *group = words(4096);
    while (__atomic_exchange_n(group, 1, __ATOMIC_ACQUIRE)) { }
    uint32_t next = group[1], result = UINT32_MAX;
    if (next <= group[2] && delta <= group[2] - next) {
        uint32_t end = next + delta, size = __builtin_wasm_memory_size(0);
        if (end <= size || __builtin_wasm_memory_grow(0, end - size) != (unsigned long)-1) {
            for (uint32_t i = 0; i < delta; i++) words(root + HEADER)[old + i] = ((next + i) * PAGE) | 3;
            group[1] = end;
            words(root)[0] = old + delta;
            result = old;
        }
    }
    __atomic_store_n(group, 0, __ATOMIC_RELEASE);
    return result;
}
