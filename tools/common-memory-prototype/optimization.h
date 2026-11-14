#ifndef COMMON_MEMORY_OPTIMIZATION_H
#define COMMON_MEMORY_OPTIMIZATION_H
#include <stdint.h>
#include <wasm_simd128.h>

// Trusted, freestanding fixture. The harness prevents mapping changes during
// a call. Cache state is invocation-local and never survives that lifetime.
#define PAGE 65536u
#define LIMIT 67108864u
#define AI static __inline__ __attribute__((always_inline))
typedef struct { uint32_t tag, entry; } Cache;
AI uint32_t entry(uint32_t p, uint32_t root) {
    // The fixed-mapping call contract permits ordinary compiler optimization
    // of metadata reads. No volatile payload operation is specialized here.
    return *(const uint32_t *)(uintptr_t)(root + ((p >> 16) << 2));
}
AI uint32_t address(uint32_t p, uint32_t width, uint32_t rights, uint32_t root) {
    if (p > LIMIT - width) __builtin_trap();
    uint32_t e = entry(p, root);
    if ((e & rights) != rights) __builtin_trap();
    return (e & -PAGE) | (p & (PAGE - 1));
}
AI uint32_t raw_read(uint32_t p) {
    uint32_t v;
    __builtin_memcpy(&v, (void *)(uintptr_t)p, 4);
    return v;
}
AI void raw_write(uint32_t p, uint32_t v) {
    __builtin_memcpy((void *)(uintptr_t)p, &v, 4);
}
AI uint32_t read32(uint32_t p, uint32_t root) {
    uint32_t a = address(p, 4, 1, root);
    if ((p & (PAGE - 1)) <= PAGE - 4) return raw_read(a);
    uint32_t v = 0;
    for (uint32_t j = 0; j < 4; j++)
        v |= (uint32_t)*(uint8_t *)(uintptr_t)address(p + j, 1, 1, root) << (j * 8);
    return v;
}
AI void write32(uint32_t p, uint32_t v, uint32_t root) {
    uint32_t a = address(p, 4, 2, root);
    if ((p & (PAGE - 1)) <= PAGE - 4) { raw_write(a, v); return; }
    (void)address(p + 3, 1, 2, root); // Preflight both pages before any store.
    for (uint32_t j = 0; j < 4; j++)
        *(uint8_t *)(uintptr_t)address(p + j, 1, 2, root) = v >> (j * 8);
}
AI uint32_t cached_address(uint32_t p, uint32_t rights, uint32_t root, Cache *c) {
    if (p > LIMIT - 4) __builtin_trap();
    uint32_t tag = (p >> 16) | (rights << 16);
    if (tag != c->tag) {
        uint32_t e = entry(p, root);
        if ((e & rights) != rights) __builtin_trap();
        c->entry = e;
        c->tag = tag;
    }
    return (c->entry & -PAGE) | (p & (PAGE - 1));
}
AI uint32_t cached_read(uint32_t p, uint32_t root, Cache *c, int aligned) {
    uint32_t a = cached_address(p, 1, root, c);
    if ((aligned && !(p & 3)) || (p & (PAGE - 1)) <= PAGE - 4) return raw_read(a);
    return read32(p, root);
}
AI void cached_write(uint32_t p, uint32_t v, uint32_t root, Cache *c, int aligned) {
    uint32_t a = cached_address(p, 2, root, c);
    if ((aligned && !(p & 3)) || (p & (PAGE - 1)) <= PAGE - 4) { raw_write(a, v); return; }
    write32(p, v, root);
}

// Nonfaulting guard: rejection never skips an original operation or causes an
// early guest fault. Callers use the original scalar path on rejection.
AI uint32_t try_span(uint32_t p, uint32_t n, uint32_t rights, uint32_t root) {
    if (!n || p >= LIMIT || n > LIMIT - p) return 0;
    uint32_t e = entry(p, root);
    if ((e & rights) != rights) return 0;
    uint32_t first = (e & -PAGE) | (p & (PAGE - 1));
    for (uint32_t q = (p & -PAGE) + PAGE; q < p + n; q += PAGE) {
        e = entry(q, root);
        if ((e & rights) != rights || (e & -PAGE) != first + q - p) return 0;
    }
    return first;
}
AI void validate_span(uint32_t p, uint32_t n, uint32_t rights, uint32_t root) {
    if (p > LIMIT || n > LIMIT - p) __builtin_trap();
    if (!n) return;
    (void)address(p, 1, rights, root);
    for (uint32_t q = (p & -PAGE) + PAGE; q < p + n; q += PAGE)
        (void)address(q, 1, rights, root);
}
AI uint32_t aligned_read(uint32_t p, uint32_t root) {
    if (!(p & 3)) return raw_read(address(p, 4, 1, root));
    return read32(p, root);
}
AI void aligned_write(uint32_t p, uint32_t v, uint32_t root) {
    if (!(p & 3)) raw_write(address(p, 4, 2, root), v);
    else write32(p, v, root);
}
uint32_t opaque_read(uint32_t p, uint32_t root);
void opaque_write(uint32_t p, uint32_t v, uint32_t root);

AI v128_t vector_read(uint32_t p, uint32_t root) {
    uint32_t a = try_span(p, 16, 1, root);
    if (a) return wasm_v128_load((void *)(uintptr_t)a);
    uint32_t a0 = read32(p, root), a1 = read32(p + 4, root);
    uint32_t a2 = read32(p + 8, root), a3 = read32(p + 12, root);
    return wasm_i32x4_make(a0, a1, a2, a3);
}
AI void vector_write(uint32_t p, v128_t v, uint32_t root) {
    uint32_t a = try_span(p, 16, 2, root);
    if (a) { wasm_v128_store((void *)(uintptr_t)a, v); return; }
    write32(p, wasm_i32x4_extract_lane(v, 0), root);
    write32(p + 4, wasm_i32x4_extract_lane(v, 1), root);
    write32(p + 8, wasm_i32x4_extract_lane(v, 2), root);
    write32(p + 12, wasm_i32x4_extract_lane(v, 3), root);
}
AI v128_t cached_vector_read(uint32_t p, uint32_t root, Cache *c) {
    uint32_t a = cached_address(p, 1, root, c);
    if ((p & (PAGE - 1)) <= PAGE - 16) return wasm_v128_load((void *)(uintptr_t)a);
    return vector_read(p, root);
}
AI void cached_vector_write(uint32_t p, v128_t v, uint32_t root, Cache *c) {
    uint32_t a = cached_address(p, 2, root, c);
    if ((p & (PAGE - 1)) <= PAGE - 16) wasm_v128_store((void *)(uintptr_t)a, v);
    else vector_write(p, v, root);
}
#endif
