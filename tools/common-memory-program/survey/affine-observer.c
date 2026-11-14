// Appended to a private helper copy. Diagnostic only: the real translated
// operation still follows this observer, with its original faults and values.
// Counter pages belong to this root's sole Worker. The host reads copied
// atomic values; no guest payload is cached, moved or exposed to browser main.
#define AFFINE_SLOTS 65792u
#define AFFINE_MAGIC 0x41464632u
struct affine_window { uint32_t first, count, physical, rights; };
struct affine_cache {
    uint32_t magic, epoch, pages, padding;
    struct affine_window prefix, private_run, shared_run;
};
_Static_assert(sizeof(struct affine_cache) <= 9ull * PAGE - AFFINE_SLOTS * 8ull,
               "affine cache must fit the existing diagnostic allocation");
AI void affine_count(uint64_t *counts, uint32_t slot) {
    __atomic_fetch_add(counts + slot, 1, __ATOMIC_RELAXED);
}
AI void affine_set(struct affine_window *w, uint32_t first, uint32_t count,
                   uint32_t physical, uint32_t rights) {
    w->first = first; w->count = count; w->physical = physical; w->rights = rights;
}
AI void affine_consider(struct affine_cache *cache, uint32_t first,
                        uint32_t count, uint32_t physical, uint32_t flags) {
    if (!count) return;
    if (flags == 3) {
        if (!first) affine_set(&cache->prefix, first, count, physical, 3);
        if (count > cache->private_run.count)
            affine_set(&cache->private_run, first, count, physical, 3);
    }
    if ((flags & 4) && count > cache->shared_run.count)
        affine_set(&cache->shared_run, first, count, physical, flags & 3);
}
AI void affine_gauge(uint64_t *counts, uint32_t slot, uint64_t value) {
    __atomic_store_n(counts + slot, value, __ATOMIC_RELAXED);
}
AI void affine_publish(uint64_t *counts, uint32_t slot, struct affine_window *w) {
    affine_gauge(counts, slot, w->first); affine_gauge(counts, slot + 1, w->count);
    affine_gauge(counts, slot + 2, w->physical); affine_gauge(counts, slot + 3, w->rights);
}
AI void affine_scan(struct affine_cache *cache, uint64_t *counts,
                    uint32_t root, uint32_t pages, uint32_t epoch, uint64_t physical_size) {
    affine_set(&cache->prefix, 0, 0, 0, 0);
    affine_set(&cache->private_run, 0, 0, 0, 0);
    affine_set(&cache->shared_run, 0, 0, 0, 0);
    uint32_t first = 0, count = 0, physical = 0, flags = 0;
    uint32_t mapped = 0, private_pages = 0, shared_pages = 0, runs = 0;
    for (uint32_t i = 0; i < pages; i++) {
        uint32_t entry = words(root + HEADER)[i], at = entry & -PAGE;
        uint32_t next_flags = entry & 7;
        uint32_t valid = at && (next_flags & 3) && (uint64_t)at + PAGE <= physical_size;
        if (valid) {
            mapped++;
            if (next_flags & 4) shared_pages++; else private_pages++;
            if (count && next_flags == flags &&
                (uint64_t)physical + (uint64_t)count * PAGE == at) {
                count++; continue;
            }
        }
        if (count) { affine_consider(cache, first, count, physical, flags); runs++; }
        if (valid) {
            first = i; count = 1; physical = at; flags = next_flags;
        } else count = 0;
    }
    if (count) { affine_consider(cache, first, count, physical, flags); runs++; }
    cache->pages = pages; cache->epoch = epoch; cache->magic = AFFINE_MAGIC;
    affine_publish(counts, 224, &cache->prefix);
    affine_publish(counts, 228, &cache->private_run);
    affine_publish(counts, 232, &cache->shared_run);
    affine_gauge(counts, 236, mapped); affine_gauge(counts, 237, private_pages);
    affine_gauge(counts, 238, shared_pages); affine_gauge(counts, 239, runs);
    affine_gauge(counts, 240, epoch); affine_gauge(counts, 241, pages);
    affine_count(counts, 153);
}
AI uint32_t affine_contains(struct affine_window *w, uint32_t first,
                            uint32_t last, uint32_t rights) {
    return w->count && first >= w->first &&
        (uint64_t)last < (uint64_t)w->first + w->count &&
        (w->rights & rights) == rights;
}
AI uint32_t affine_matches(struct affine_window *w, uint32_t first,
                           uint32_t last, uint32_t a, uint32_t b) {
    return (uint64_t)w->physical + (uint64_t)(first - w->first) * PAGE == (a & -PAGE) &&
        (uint64_t)w->physical + (uint64_t)(last - w->first) * PAGE == (b & -PAGE) &&
        (a & 7) == (b & 7) && (a & 3) == w->rights;
}
EXPORT("vm_affine_observe")
void vm_affine_observe(uint32_t base, uint64_t offset, uint32_t width,
                        uint32_t rights, uint32_t root) {
    uint64_t physical_size = (uint64_t)__builtin_wasm_memory_size(0) * PAGE;
    if (!root || (uint64_t)root + HEADER > physical_size ||
        words(root)[15] != 0x4b564d31u) fail();
    uint32_t diagnostic = words(root)[14];
    if (!diagnostic || diagnostic % PAGE ||
        (uint64_t)diagnostic + 9ull * PAGE > physical_size) fail();
    uint64_t *counts = (uint64_t *)(uintptr_t)diagnostic;
    affine_count(counts, 144);
    uint32_t pages = words(root)[0], epoch = words(root)[4];
    if (pages > 65536 || (uint64_t)root + HEADER + (uint64_t)pages * 4 > physical_size) fail();
    if (!width || width > 16 || !rights || (rights & ~3u)) fail();
    if (offset > UINT32_MAX) { affine_count(counts, 151); return; }
    uint64_t address = (uint64_t)base + offset, end = address + width;
    if (address > UINT32_MAX || end > (uint64_t)pages * PAGE) {
        affine_count(counts, 151); return;
    }
    if (!epoch) { affine_count(counts, 152); return; }
    struct affine_cache *cache = (struct affine_cache *)(uintptr_t)(diagnostic + AFFINE_SLOTS * 8);
    if (cache->magic != AFFINE_MAGIC || cache->epoch != epoch || cache->pages != pages)
        affine_scan(cache, counts, root, pages, epoch, physical_size);
    uint32_t first = (uint32_t)address >> 16, last = (uint32_t)((end - 1) >> 16);
    if (first != last) affine_count(counts, 157);
    uint32_t a = words(root + HEADER)[first], b = words(root + HEADER)[last];
    if (!(a & -PAGE) || !(b & -PAGE) || (a & rights) != rights || (b & rights) != rights ||
        (uint64_t)(a & -PAGE) + PAGE > physical_size || (uint64_t)(b & -PAGE) + PAGE > physical_size) {
        affine_count(counts, 156); return;
    }
    uint32_t prefix = affine_contains(&cache->prefix, first, last, rights);
    uint32_t private_run = affine_contains(&cache->private_run, first, last, rights);
    uint32_t shared_run = affine_contains(&cache->shared_run, first, last, rights);
    // Check the live entries even with an unchanged epoch. This is only a
    // diagnostic opportunity counter, not a certificate for eliding PTE reads.
    if ((prefix && ((a | b) & 4 || !affine_matches(&cache->prefix, first, last, a, b))) ||
        (private_run && ((a | b) & 4 || !affine_matches(&cache->private_run, first, last, a, b))) ||
        (shared_run && (!(a & b & 4) || !affine_matches(&cache->shared_run, first, last, a, b)))) {
        affine_count(counts, 154); cache->magic = 0; return;
    }
    // A dense private plane can remain affine on both sides of shared holes.
    // This address-wise observation does NOT prove a whole-plane fast path:
    // every hole, alias, permission exception and shared mapping still matters.
    uint32_t private_plane = cache->prefix.count && (a & 7) == 3 && (b & 7) == 3 &&
        (uint64_t)cache->prefix.physical + (uint64_t)first * PAGE == (a & -PAGE) &&
        (uint64_t)cache->prefix.physical + (uint64_t)last * PAGE == (b & -PAGE);
    // One classification bin plus the attempt counter keeps diagnostic
    // overhead bounded. Marginals/unions are derived from these exact bins.
    uint32_t mask = prefix | private_run * 2 | shared_run * 4 | private_plane * 8;
    affine_count(counts, 160 + mask);
}
