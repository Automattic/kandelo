// Appended only to a private copy of helpers.c for --guard-object-functions.
// This non-trapping guard reads mapping metadata, never guest payload. Mapping
// changes remain serialized at process stop under the experimental contract.
// Requiring union rights over gaps is conservative: misses run original code.
EXPORT("vm_try_span")
uint32_t vm_try_span(uint32_t p, uint32_t n, uint32_t rights, uint32_t root) {
    uint64_t physical_size = (uint64_t)__builtin_wasm_memory_size(0) * PAGE;
    if (!root || (uint64_t)root + HEADER > physical_size || !n || n > PAGE ||
        !rights || (rights & ~3u)) return 0;
    uint32_t pages = words(root)[0];
    uint64_t end = (uint64_t)p + n;
    if (pages > 65536 || end > (uint64_t)pages * PAGE) return 0;
    uint32_t first_page = p >> 16, last_page = (uint32_t)((end - 1) >> 16);
    if ((uint64_t)root + HEADER + ((uint64_t)last_page + 1) * 4 > physical_size)
        return 0;
    uint32_t entry = words(root + HEADER)[first_page];
    uint32_t physical_page = entry & -PAGE;
    if (!physical_page || (entry & rights) != rights) return 0;
    uint64_t first = (uint64_t)physical_page + (p & (PAGE - 1));
    if (first + n > physical_size) return 0;
    for (uint32_t page_index = first_page + 1; page_index <= last_page; page_index++) {
        entry = words(root + HEADER)[page_index];
        uint64_t expected = (uint64_t)physical_page +
            (uint64_t)(page_index - first_page) * PAGE;
        if ((entry & rights) != rights || !((uint32_t)entry & -PAGE) ||
            expected != (uint32_t)(entry & -PAGE)) return 0;
    }
    return (uint32_t)first;
}
