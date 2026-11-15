// Private plain-profile layout: words6..11 are owned by this cache strategy.
// Do not mix it with root-header page caches or diagnostic guards using6/7.
// The owning process's sole Worker executes this without mapping callbacks.
AI void affine_bind_run(uint32_t root, uint32_t first, uint32_t count,
                         uint32_t physical, uint32_t flags) {
    if (!count) return;
    if (!first && flags == 3) { words(root)[6] = physical; words(root)[7] = count; }
    if ((flags & 4) && count > words(root)[9] - words(root)[8]) {
        words(root)[8] = first; words(root)[9] = first + count;
        words(root)[10] = physical; words(root)[11] = flags & 3;
    }
}
EXPORT("vm_affine_bind")
uint32_t vm_affine_bind(uint32_t root) {
    uint64_t size = (uint64_t)__builtin_wasm_memory_size(0) * PAGE;
    if (!root || (uint64_t)root + HEADER > size) return 0;
    uint32_t pages = words(root)[0], maximum = words(root)[1], epoch = words(root)[4];
    if (!epoch || maximum > 65536 || pages > maximum ||
        (uint64_t)root + HEADER + (uint64_t)maximum * 4 > size) return 0;
    for (uint32_t i = 6; i < 12; i++) words(root)[i] = 0;
    uint32_t first = 0, count = 0, physical = 0, flags = 0;
    for (uint32_t i = 0; i < pages; i++) {
        uint32_t entry = words(root + HEADER)[i], at = entry & -PAGE, next_flags = entry & 7;
        uint32_t valid = at && (next_flags & 3) && (uint64_t)at + PAGE <= size;
        if (valid && count && next_flags == flags &&
            (uint64_t)physical + (uint64_t)count * PAGE == at) { count++; continue; }
        affine_bind_run(root, first, count, physical, flags);
        if (valid) { first = i; count = 1; physical = at; flags = next_flags; }
        else count = 0;
    }
    affine_bind_run(root, first, count, physical, flags);
    // Defensive recheck, not support for concurrent mutation of this root.
    return words(root)[0] == pages && words(root)[4] == epoch;
}
