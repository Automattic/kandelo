/* Bounded parallel moves for fragmented, aliased virtual mappings.
 *
 * The caller supplies address translation, raw byte/copy operations and a
 * stop-only poll. Mapping barriers must still wait for this helper to return:
 * its physical graph cursors are not a mapping-quiescence acknowledgement.
 *
 * A physical destination has one final writer: its last virtual occurrence.
 * That writer's physical source is its parent in a functional graph. Trees
 * move children before parents; cycles rotate through one saved value. This
 * gives the same result as a complete source snapshot followed by ascending
 * destination writes, including repeated destination mappings.
 */
#pragma once

struct vm_copy_graph_context {
    uint32_t dst, src, n, root, replica, scratch, capacity;
    uint32_t unit, seen_bytes, temporary;
};

VM_COPY_INLINE uint32_t vm_copy_last_index(
    const struct vm_copy_graph_context *c, uint32_t physical) {
    uint32_t last = UINT32_MAX;
    uint32_t offset = physical & (VM_COPY_PAGE_BYTES - 1);
    uint32_t first = c->dst / VM_COPY_PAGE_BYTES;
    uint32_t end = (uint32_t)(((uint64_t)c->dst + c->n - 1) / VM_COPY_PAGE_BYTES);
    for (uint32_t vp = first; vp <= end; vp++) {
        vm_copy_poll(c->root, c->replica);
        uint64_t v = (uint64_t)vp * VM_COPY_PAGE_BYTES + offset;
        if (v < c->dst || v - c->dst >= c->n) continue;
        if (vm_copy_address((uint32_t)v, 2, c->root) == physical)
            last = (uint32_t)(v - c->dst);
    }
    return last;
}

VM_COPY_INLINE uint32_t vm_copy_parent(
    const struct vm_copy_graph_context *c, uint32_t physical) {
    uint32_t i = vm_copy_last_index(c, physical);
    return i == UINT32_MAX ? 0 : vm_copy_address(c->src + i, 1, c->root);
}

VM_COPY_INLINE uint32_t vm_copy_seen(
    const struct vm_copy_graph_context *c, uint32_t physical) {
    if (!c->seen_bytes) return 0;
    uint32_t i = vm_copy_last_index(c, physical) / c->unit;
    return vm_copy_read(c->scratch + i / 8) & (1u << (i & 7));
}

VM_COPY_INLINE void vm_copy_mark(
    const struct vm_copy_graph_context *c, uint32_t physical) {
    if (!c->seen_bytes) return;
    uint32_t i = vm_copy_last_index(c, physical) / c->unit;
    uint32_t p = c->scratch + i / 8;
    vm_copy_write(p, vm_copy_read(p) | (1u << (i & 7)));
}

/* Enumerate reverse edges from source page references, not every byte. */
VM_COPY_INLINE uint32_t vm_copy_child(
    const struct vm_copy_graph_context *c, uint32_t parent,
    uint32_t after, uint32_t forbidden) {
    uint32_t best = 0;
    uint32_t offset = parent & (VM_COPY_PAGE_BYTES - 1);
    uint32_t first = c->src / VM_COPY_PAGE_BYTES;
    uint32_t end = (uint32_t)(((uint64_t)c->src + c->n - 1) / VM_COPY_PAGE_BYTES);
    for (uint32_t vp = first; vp <= end; vp++) {
        vm_copy_poll(c->root, c->replica);
        uint64_t v = (uint64_t)vp * VM_COPY_PAGE_BYTES + offset;
        if (v < c->src || v - c->src >= c->n) continue;
        if (vm_copy_address((uint32_t)v, 1, c->root) != parent) continue;
        uint32_t i = (uint32_t)(v - c->src);
        uint32_t child = vm_copy_address(c->dst + i, 2, c->root);
        if (child <= after || child == forbidden || (best && child >= best)) continue;
        if (vm_copy_last_index(c, child) != i || vm_copy_seen(c, child)) continue;
        best = child;
    }
    return best;
}

/* Parent links come from immutable mapping metadata, so postorder needs no
 * recursive C stack or separately allocated traversal stack. */
VM_COPY_INLINE void vm_copy_tree(
    const struct vm_copy_graph_context *c, uint32_t root,
    uint32_t forbidden, uint32_t write_root) {
    uint32_t node = root, after = 0;
    for (;;) {
        vm_copy_poll(c->root, c->replica);
        uint32_t child = vm_copy_child(c, node, after, node == root ? forbidden : 0);
        if (child) { node = child; after = 0; continue; }
        uint32_t parent = vm_copy_parent(c, node);
        if (node != root || write_root) {
            vm_copy_raw(node, parent, c->unit);
            vm_copy_mark(c, node);
        }
        if (node == root) return;
        after = node;
        node = parent;
    }
}

VM_COPY_INLINE void vm_copy_cycle(
    const struct vm_copy_graph_context *c, uint32_t first) {
    uint32_t predecessor = first;
    while (vm_copy_parent(c, predecessor) != first) {
        vm_copy_poll(c->root, c->replica);
        predecessor = vm_copy_parent(c, predecessor);
    }
    uint32_t node = first;
    do {
        vm_copy_tree(c, node, predecessor, 0);
        predecessor = node;
        node = vm_copy_parent(c, node);
    } while (node != first);

    uint8_t byte = 0;
    if (c->unit == 1) byte = vm_copy_read(first);
    else vm_copy_raw(c->temporary, first, c->unit);
    node = first;
    uint32_t parent = vm_copy_parent(c, node);
    while (parent != first) {
        vm_copy_poll(c->root, c->replica);
        vm_copy_raw(node, parent, c->unit);
        vm_copy_mark(c, node);
        node = parent;
        parent = vm_copy_parent(c, node);
    }
    if (c->unit == 1) vm_copy_write(node, byte);
    else vm_copy_raw(node, c->temporary, c->unit);
    vm_copy_mark(c, node);
}

/* Returns a cycle member, or zero for a tree ending outside the destination. */
VM_COPY_INLINE uint32_t vm_copy_meeting(
    const struct vm_copy_graph_context *c, uint32_t first) {
    uint32_t slow = first, fast = first;
    do {
        vm_copy_poll(c->root, c->replica);
        slow = vm_copy_parent(c, slow);
        fast = vm_copy_parent(c, fast);
        if (fast) fast = vm_copy_parent(c, fast);
    } while (slow && fast && slow != fast);
    return slow && fast ? slow : 0;
}

VM_COPY_INLINE void vm_copy_graph(struct vm_copy_graph_context *c) {
    if (!c->n) return;
    uint32_t alignment = c->dst | c->src | c->n | VM_COPY_PAGE_BYTES;
    c->unit = alignment & (0u - alignment);
    c->seen_bytes = 0;
    for (;;) {
        uint32_t seen = (uint32_t)(((uint64_t)c->n / c->unit + 7) / 8);
        uint32_t temporary = c->unit == 1 ? 0 : c->unit;
        if (c->capacity >= temporary && seen <= c->capacity - temporary) {
            c->seen_bytes = seen;
            break;
        }
        if (c->unit == 1) break;
        c->unit /= 2;
    }
    c->temporary = c->scratch + c->seen_bytes;
    for (uint32_t i = 0; i < c->seen_bytes; i++) {
        if (!(i & (VM_COPY_PAGE_BYTES - 1))) vm_copy_poll(c->root, c->replica);
        vm_copy_write(c->scratch + i, 0);
    }

    for (uint64_t i = 0; i < c->n; i += c->unit) {
        vm_copy_poll(c->root, c->replica);
        uint32_t node = vm_copy_address(c->dst + (uint32_t)i, 2, c->root);
        if (vm_copy_last_index(c, node) != i || vm_copy_seen(c, node)) continue;
        uint32_t parent = vm_copy_parent(c, node);
        if (vm_copy_last_index(c, parent) == UINT32_MAX) {
            vm_copy_tree(c, node, 0, 1);
            continue;
        }
        uint32_t meeting = vm_copy_meeting(c, node);
        if (c->seen_bytes) {
            if (meeting) vm_copy_cycle(c, meeting);
            else {
                uint32_t top = node;
                while (vm_copy_last_index(c, vm_copy_parent(c, top)) != UINT32_MAX) {
                    vm_copy_poll(c->root, c->replica);
                    top = vm_copy_parent(c, top);
                }
                vm_copy_tree(c, top, 0, 1);
            }
        } else if (meeting == node) {
            /* Without workspace, select one canonical leader per cycle. */
            uint32_t minimum = node, next = parent;
            while (next != node) {
                vm_copy_poll(c->root, c->replica);
                if (next < minimum) minimum = next;
                next = vm_copy_parent(c, next);
            }
            if (minimum == node) vm_copy_cycle(c, node);
        }
    }
}

/* A scratch-local page bitmap proves when ordinary forward/backward moves
 * remain safe despite fragmented backing. Aliased source/destination pages
 * that denote different virtual pages require the graph path instead. */
VM_COPY_INLINE uint32_t vm_copy_can_stream(const struct vm_copy_graph_context *c) {
    if (c->capacity < 2 * VM_COPY_BITMAP_BYTES) return 0;
    for (uint32_t i = 0; i < 2 * VM_COPY_BITMAP_BYTES; i++) vm_copy_write(c->scratch + i, 0);
    uint32_t src_first = c->src / VM_COPY_PAGE_BYTES;
    uint32_t src_last = (uint32_t)(((uint64_t)c->src + c->n - 1) / VM_COPY_PAGE_BYTES);
    uint32_t dst_first = c->dst / VM_COPY_PAGE_BYTES;
    uint32_t dst_last = (uint32_t)(((uint64_t)c->dst + c->n - 1) / VM_COPY_PAGE_BYTES);
    uint32_t src_alias = 0, dst_alias = 0, cross_alias = 0, overlap = 0;
    for (uint32_t vp = src_first; vp <= src_last; vp++) {
        vm_copy_poll(c->root, c->replica);
        uint32_t p = vm_copy_address(vp * VM_COPY_PAGE_BYTES, 1, c->root) / VM_COPY_PAGE_BYTES;
        if (p >= 8 * VM_COPY_BITMAP_BYTES) return 0;
        uint32_t byte = c->scratch + p / 8, bit = 1u << (p & 7);
        uint8_t old = vm_copy_read(byte);
        if (old & bit) src_alias = 1;
        vm_copy_write(byte, old | bit);
    }
    for (uint32_t vp = dst_first; vp <= dst_last; vp++) {
        vm_copy_poll(c->root, c->replica);
        uint32_t p = vm_copy_address(vp * VM_COPY_PAGE_BYTES, 2, c->root) / VM_COPY_PAGE_BYTES;
        if (p >= 8 * VM_COPY_BITMAP_BYTES) return 0;
        uint32_t byte = c->scratch + VM_COPY_BITMAP_BYTES + p / 8, bit = 1u << (p & 7);
        uint8_t old = vm_copy_read(byte);
        if (old & bit) dst_alias = 1;
        vm_copy_write(byte, old | bit);
        if (vm_copy_read(c->scratch + p / 8) & bit) {
            overlap = 1;
            if (vp < src_first || vp > src_last) cross_alias = 1;
        }
    }
    return !overlap || (!src_alias && !dst_alias && !cross_alias);
}

VM_COPY_INLINE void vm_copy_stream(const struct vm_copy_graph_context *c) {
    uint32_t remaining = c->n;
    uint32_t backward = c->dst > c->src && (uint64_t)c->dst < (uint64_t)c->src + c->n;
    uint32_t done = 0;
    while (remaining) {
        vm_copy_poll(c->root, c->replica);
        uint32_t src, dst, chunk;
        if (backward) {
            uint32_t s = (uint32_t)((uint64_t)c->src + remaining - 1);
            uint32_t d = (uint32_t)((uint64_t)c->dst + remaining - 1);
            chunk = (s & (VM_COPY_PAGE_BYTES - 1)) + 1;
            uint32_t tail = (d & (VM_COPY_PAGE_BYTES - 1)) + 1;
            if (chunk > tail) chunk = tail;
            if (chunk > remaining) chunk = remaining;
            src = c->src + remaining - chunk;
            dst = c->dst + remaining - chunk;
        } else {
            src = c->src + done; dst = c->dst + done;
            chunk = VM_COPY_PAGE_BYTES - (src & (VM_COPY_PAGE_BYTES - 1));
            uint32_t tail = VM_COPY_PAGE_BYTES - (dst & (VM_COPY_PAGE_BYTES - 1));
            if (chunk > tail) chunk = tail;
            if (chunk > remaining) chunk = remaining;
            done += chunk;
        }
        vm_copy_raw(vm_copy_address(dst, 2, c->root), vm_copy_address(src, 1, c->root), chunk);
        remaining -= chunk;
    }
}

/* Both logical ranges and their permissions must be preflighted by the
 * caller. source_span/destination_span are zero for fragmented ranges. */
VM_COPY_INLINE void vm_copy_bounded(
    struct vm_copy_graph_context *c, uint32_t source_span, uint32_t destination_span) {
    if (!c->n || c->dst == c->src) return;
    if (source_span && destination_span) {
        vm_copy_raw(destination_span, source_span, c->n);
    } else if (c->n <= c->capacity) {
        for (uint32_t i = 0; i < c->n; i++) {
            if (!(i & (VM_COPY_PAGE_BYTES - 1))) vm_copy_poll(c->root, c->replica);
            vm_copy_write(c->scratch + i, vm_copy_read(vm_copy_address(c->src + i, 1, c->root)));
        }
        for (uint32_t i = 0; i < c->n; i++) {
            if (!(i & (VM_COPY_PAGE_BYTES - 1))) vm_copy_poll(c->root, c->replica);
            vm_copy_write(vm_copy_address(c->dst + i, 2, c->root), vm_copy_read(c->scratch + i));
        }
    } else if (vm_copy_can_stream(c)) {
        vm_copy_stream(c);
    } else {
        vm_copy_graph(c);
    }
}
