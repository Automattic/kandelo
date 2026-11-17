#include <stdint.h>
#include "group-layout.h"

// Trusted experimental address space. Root header: current pages, maximum
// pages, scatter-copy capacity, initialized. PTEs follow a 64-byte header.
// Each replica has its own control block and scratch; root word 13
// serializes growth against the owning kernel realm. Concurrent unmap still
// requires the application to stop using the unmapped addresses.
#define PAGE KANDELO_MG_PAGE_BYTES
#define HEADER KANDELO_MG_ROOT_HEADER_BYTES
#define AI static __inline__ __attribute__((always_inline))
#define EXPORT(name) __attribute__((export_name(name)))
// The normal translator validates each exact () -> i32 constant body against
// the Rust declaration before accepting this compiled helper. This proves
// layout agreement, not correctness of arbitrary helper implementation code.
#define LAYOUT_MARKER(name, value) \
    EXPORT("vm_layout_" #name) uint32_t vm_layout_##name(void) { return value; }
KANDELO_MG_LAYOUT_MARKERS(LAYOUT_MARKER)
#undef LAYOUT_MARKER
AI uint32_t *words(uint32_t p) { return (uint32_t *)(uintptr_t)p; }
AI void fail(void) { __builtin_trap(); }
AI uint32_t r_load(uint32_t replica, uint32_t offset) {
    return __atomic_load_n(words(replica+offset), __ATOMIC_ACQUIRE);
}
AI uint32_t r_alive(uint32_t root, uint32_t replica) {
    return __atomic_load_n(words(root+KANDELO_MG_ROOT_RUN), __ATOMIC_ACQUIRE)
        && r_load(replica,KANDELO_MG_REPLICA_RUN);
}
AI void r_ack(uint32_t replica,uint32_t epoch) {
    __atomic_store_n(words(replica+KANDELO_MG_REPLICA_ACK),epoch,__ATOMIC_RELEASE);
    __builtin_wasm_memory_atomic_notify((int*)words(replica+KANDELO_MG_REPLICA_ACK),1);
}
// Source safe points have no surviving physical address temporary. A queue
// acknowledgment is weaker: its physical wait target stays pinned until the
// returning helper retires its node. Neither acknowledgment is a stop fence.
EXPORT("vm_checkpoint")
void vm_checkpoint(uint32_t root,uint32_t replica) {
    if(!root||!replica||!r_alive(root,replica))fail();
    uint32_t epoch=r_load(replica,KANDELO_MG_REPLICA_REQUEST);
    while(epoch) {
        r_ack(replica,epoch);
        while(r_load(replica,KANDELO_MG_REPLICA_REQUEST)==epoch) {
            if(!r_alive(root,replica))fail();
            __builtin_wasm_memory_atomic_wait32((int*)words(replica+KANDELO_MG_REPLICA_REQUEST),epoch,-1);
        }
        if(!r_alive(root,replica))fail();
        epoch=r_load(replica,KANDELO_MG_REPLICA_REQUEST);
    }
    // ACK is the last acknowledged epoch. The owner must require its exact
    // currently requested epoch, never treat a stale ACK as current parking.
}
AI uint32_t effective(uint32_t p, uint64_t offset, uint32_t n, uint32_t root) {
    if (!root || offset > UINT32_MAX) fail();
    uint64_t q = (uint64_t)p + offset;
    uint64_t limit = (uint64_t)__atomic_load_n(&words(root)[0], __ATOMIC_ACQUIRE) * PAGE;
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
uint32_t vm_size(uint32_t root) { if (!root) fail(); return __atomic_load_n(&words(root)[0], __ATOMIC_ACQUIRE); }
EXPORT("vm_initialize_gate")
uint32_t vm_initialize_gate(uint32_t root, uint32_t fresh, uint32_t replica) {
    if (!root || !replica || replica%KANDELO_MG_REPLICA_BYTES || fresh > 2 || words(root)[0] > words(root)[1]
        || words(replica+KANDELO_MG_REPLICA_MAGIC_OFFSET)[0]!=KANDELO_MG_REPLICA_MAGIC
        || words(replica+KANDELO_MG_REPLICA_ROOT)[0]!=root || !r_alive(root,replica)) fail();
    if (fresh == 2) {
        if (__atomic_load_n(&words(root)[3], __ATOMIC_ACQUIRE) != 1) fail();
        return 0; // Attach: drop this instance's active data without replaying it.
    }
    uint32_t expected = 0;
    if (!__atomic_compare_exchange_n(&words(root)[3], &expected, 1, 0, __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE)) fail();
    return fresh;
}
// The same bitmap is used by the kernel-realm host allocator. Root lock then
// group lock is the only lock order. No page becomes reachable until zeroed.
AI uint32_t pool_used(uint32_t p) {
    return words(KANDELO_MG_BITMAP)[p>>5] & (1u<<(p&31));
}
AI void pool_mark(uint32_t p) {
    words(KANDELO_MG_BITMAP)[p>>5] |= 1u<<(p&31);
}
EXPORT("vm_grow")
uint32_t vm_grow(uint32_t delta,uint32_t root) {
    if(!root)fail();
    uint32_t *group=words(KANDELO_MG_CONTROL);
    if(group[3]!=KANDELO_MG_MAGIC || !group[2] || group[2]>KANDELO_MG_MAXIMUM_PAGES)fail();
    uint32_t *growth=words(root+KANDELO_MG_ROOT_GROW_LOCK);
    while(__atomic_exchange_n(growth,1,__ATOMIC_ACQUIRE)) { }
    uint32_t old=words(root)[0],result=UINT32_MAX;
    if(old>words(root)[1] || delta>words(root)[1]-old)goto done;
    if(!delta){result=old;goto done;}
    while(__atomic_exchange_n(group,1,__ATOMIC_ACQUIRE)) { }
    uint32_t found=0,end=1;
    for(uint32_t p=1;p<group[2] && found<delta;p++) {
        if(!pool_used(p)){found++;end=p+1;}
    }
    if(found==delta) {
        uint32_t size=__builtin_wasm_memory_size(0);
        if(end<=size || __builtin_wasm_memory_grow(0,end-size)!=(unsigned long)-1) {
            uint32_t installed=0;
            for(uint32_t p=1;p<end && installed<delta;p++) {
                if(pool_used(p))continue;
                __builtin_memset((void*)(uintptr_t)(p*PAGE),0,PAGE);
                pool_mark(p);
                words(root+HEADER)[old+installed]=(p*PAGE)|3;installed++;
            }
            if(end>group[1])group[1]=end;
            __atomic_store_n(&words(root)[0],old+delta,__ATOMIC_RELEASE);result=old;
        }
    }
    __atomic_store_n(group,0,__ATOMIC_RELEASE);
    __builtin_wasm_memory_atomic_notify((int*)group,1);
done:
    __atomic_store_n(growth,0,__ATOMIC_RELEASE);
    __builtin_wasm_memory_atomic_notify((int*)growth,1);
    return result;
}

#include "vm-wait-queue.h"
