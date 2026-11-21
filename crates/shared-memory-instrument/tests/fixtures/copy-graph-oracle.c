#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define VM_COPY_PAGE_BYTES 4u
#define VM_COPY_BITMAP_BYTES 1u
#define VM_COPY_INLINE static __inline__ __attribute__((always_inline))
enum { VIRTUAL_PAGES = 32, EXHAUSTIVE_PAGES = 4, PHYSICAL_PAGES = 3, SCRATCH = 20, MEMORY = 40 };
static uint32_t mapping[VIRTUAL_PAGES];
static uint8_t memory[MEMORY];
static unsigned polls;
VM_COPY_INLINE uint32_t vm_copy_address(uint32_t v, uint32_t rights, uint32_t root) {
    (void)rights; (void)root;
    assert(v < VIRTUAL_PAGES * VM_COPY_PAGE_BYTES);
    return mapping[v / VM_COPY_PAGE_BYTES] * VM_COPY_PAGE_BYTES + v % VM_COPY_PAGE_BYTES;
}
VM_COPY_INLINE void vm_copy_raw(uint32_t d, uint32_t s, uint32_t n) {
    assert(d + n <= MEMORY && s + n <= MEMORY);
    memmove(memory + d, memory + s, n);
}
VM_COPY_INLINE uint8_t vm_copy_read(uint32_t p) { assert(p < MEMORY); return memory[p]; }
VM_COPY_INLINE void vm_copy_write(uint32_t p, uint8_t v) { assert(p < MEMORY); memory[p] = v; }
VM_COPY_INLINE void vm_copy_poll(uint32_t root, uint32_t replica) {
    (void)root; (void)replica;
    assert(++polls < 1000000);
}
#include "../../helpers/copy-graph.h"

VM_COPY_INLINE uint32_t span(uint32_t v, uint32_t n) {
    if (!n) return 0;
    uint32_t first = vm_copy_address(v, 1, 0);
    for (uint32_t i = 0; i < n; i++)
        if (vm_copy_address(v + i, 1, 0) != first + i) return 0;
    return first;
}

int main(void) {
    const uint32_t capacities[] = {0, 1, 2, 3, 4, 7, 8};
    uint64_t cases = 0;
    for (uint32_t encoding = 0; encoding < 81; encoding++) {
        uint32_t encoded = encoding;
        for (unsigned p = 0; p < EXHAUSTIVE_PAGES; p++) {
            mapping[p] = 1 + encoded % PHYSICAL_PAGES;
            encoded /= PHYSICAL_PAGES;
        }
        for (unsigned seed = 0; seed < 2; seed++)
        for (unsigned cap = 0; cap < sizeof(capacities) / sizeof(capacities[0]); cap++)
        for (uint32_t src = 0; src <= EXHAUSTIVE_PAGES * VM_COPY_PAGE_BYTES; src++)
        for (uint32_t dst = 0; dst <= EXHAUSTIVE_PAGES * VM_COPY_PAGE_BYTES; dst++) {
            uint32_t maximum = EXHAUSTIVE_PAGES * VM_COPY_PAGE_BYTES - (src > dst ? src : dst);
            for (uint32_t n = 0; n <= maximum; n++)
            for (unsigned variant = 0; variant < 2; variant++) {
                uint8_t expected[MEMORY], snapshot[VIRTUAL_PAGES * VM_COPY_PAGE_BYTES];
                for (unsigned i = 0; i < MEMORY; i++) memory[i] = (uint8_t)(i * 37 + seed * 113);
                memcpy(expected, memory, MEMORY);
                for (uint32_t i = 0; i < n; i++) snapshot[i] = memory[vm_copy_address(src + i, 1, 0)];
                for (uint32_t i = 0; i < n; i++) expected[vm_copy_address(dst + i, 2, 0)] = snapshot[i];
                struct vm_copy_graph_context context = {
                    .dst = dst, .src = src, .n = n, .scratch = SCRATCH, .capacity = capacities[cap],
                };
                polls = 0;
                if (variant) vm_copy_bounded(&context, span(src, n), span(dst, n));
                else vm_copy_graph(&context);
                if (memcmp(memory, expected, SCRATCH) != 0) {
                    fprintf(stderr, "copy oracle failed: variant=%u map=%u src=%u dst=%u n=%u cap=%u unit=%u seen=%u\n",
                        variant, encoding, src, dst, n, capacities[cap], context.unit, context.seen_bytes);
                    return 1;
                }
                /* The bounded workspace must not touch its neighbours. */
                if (memcmp(memory + SCRATCH + capacities[cap], expected + SCRATCH + capacities[cap],
                        MEMORY - SCRATCH - capacities[cap]) != 0) return 2;
                cases++;
            }
        }
    }
    printf("copy_graph_snapshot_oracle_cases=%llu\n", (unsigned long long)cases);
    uint32_t sparse_cases = 0;
    for (uint32_t pages = 1; pages <= PHYSICAL_PAGES; pages++)
    for (uint32_t src = 0; src < 4; src++)
    for (uint32_t dst = 0; dst < 4; dst++) {
        if (src == dst) continue;
        uint32_t n = VIRTUAL_PAGES * VM_COPY_PAGE_BYTES - (src > dst ? src : dst);
        for (uint32_t vp = 0; vp < VIRTUAL_PAGES; vp++) mapping[vp] = 1 + vp % pages;
        for (unsigned seed = 0; seed < 2; seed++)
        for (unsigned variant = 0; variant < 2; variant++) {
            uint8_t expected[MEMORY], snapshot[VIRTUAL_PAGES * VM_COPY_PAGE_BYTES];
            for (unsigned i = 0; i < MEMORY; i++) memory[i] = (uint8_t)(i * 37 + seed * 113);
            memcpy(expected, memory, MEMORY);
            for (uint32_t i = 0; i < n; i++) snapshot[i] = memory[vm_copy_address(src + i, 1, 0)];
            for (uint32_t i = 0; i < n; i++) expected[vm_copy_address(dst + i, 2, 0)] = snapshot[i];
            uint32_t capacity = 2 * pages + (pages * VM_COPY_PAGE_BYTES + 7) / 8;
            struct vm_copy_graph_context context = {
                .dst = dst, .src = src, .n = n, .scratch = SCRATCH, .capacity = capacity,
            };
            polls = 0;
            if (variant) vm_copy_bounded(&context, span(src, n), span(dst, n));
            else vm_copy_graph(&context);
            assert(context.seen_pages == pages);
            assert(memcmp(memory, expected, SCRATCH) == 0);
            assert(memcmp(memory + SCRATCH + capacity, expected + SCRATCH + capacity,
                MEMORY - SCRATCH - capacity) == 0);
            sparse_cases++;
        }
    }
    printf("copy_graph_sparse_oracle_cases=%u\n", sparse_cases);
    return 0;
}
